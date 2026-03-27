#!/bin/bash
# Claude Code 상태 라인을 표시하는 스크립트

# ── ANSI 색상 상수 ──
readonly C_RESET='\033[0m'
readonly C_BOLD='\033[1m'
readonly C_DIM='\033[2m'
readonly C_RED='\033[31m'
readonly C_GREEN='\033[32m'
readonly C_YELLOW='\033[33m'
readonly C_BLUE='\033[34m'
readonly C_MAGENTA='\033[35m'
readonly C_CYAN='\033[36m'
readonly SEP=" ${C_BOLD}|${C_RESET} "

# ── OS 판별 (uname 호출 1회) ──
readonly IS_DARWIN=$([ "$(uname)" = "Darwin" ] && echo 1)

# ── API 사용량 설정 ──
readonly USAGE_CACHE_DIR="$HOME/.cache/byj-cc-statusline"
readonly USAGE_CACHE_FILE="$USAGE_CACHE_DIR/usage.json"
readonly USAGE_LOCK_FILE="$USAGE_CACHE_DIR/usage.lock"
readonly USAGE_CACHE_MAX_AGE=180
readonly USAGE_LOCK_MAX_AGE=30
readonly USAGE_RATE_LIMIT_BACKOFF=300
readonly USAGE_API_TIMEOUT=5

# ── 유틸리티 함수 ──

# 캐시 파일의 나이를 초 단위로 반환
get_file_age() {
    local file="$1"
    [ -f "$file" ] || return 1
    local now mtime
    now=$(date +%s)
    if [ -n "$IS_DARWIN" ]; then
        mtime=$(stat -f %m "$file" 2>/dev/null) || return 1
    else
        mtime=$(stat -c %Y "$file" 2>/dev/null) || return 1
    fi
    echo $((now - mtime))
}

# Lock 파일이 활성 상태인지 확인 (true=차단됨)
is_locked() {
    [ -f "$USAGE_LOCK_FILE" ] || return 1
    local now blocked_until
    now=$(date +%s)
    blocked_until=$(jq -r '.blockedUntil // 0' "$USAGE_LOCK_FILE" 2>/dev/null)
    [ "$blocked_until" -gt "$now" ] 2>/dev/null
}

# Lock 파일 기록
write_lock() {
    printf '{"blockedUntil":%d}' "$1" > "$USAGE_LOCK_FILE"
}

# OAuth 토큰 가져오기 (macOS Keychain → credentials 파일 순)
get_usage_token() {
    local token=""

    if [ -n "$IS_DARWIN" ]; then
        local secret
        secret=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
        if [ -n "$secret" ]; then
            token=$(echo "$secret" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
        fi
    fi

    if [ -z "$token" ]; then
        local cred_file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
        if [ -f "$cred_file" ]; then
            token=$(jq -r '.claudeAiOauth.accessToken // empty' "$cred_file" 2>/dev/null)
        fi
    fi

    echo "$token"
}

# API 호출 후 캐시에 저장
fetch_and_cache_usage() {
    local token
    token=$(get_usage_token)
    [ -z "$token" ] && return 1

    is_locked && return 1

    local now
    now=$(date +%s)
    write_lock $((now + USAGE_LOCK_MAX_AGE))

    local header_file body http_code
    header_file=$(mktemp)
    body=$(curl -s --max-time "$USAGE_API_TIMEOUT" \
        -H "Authorization: Bearer $token" \
        -H "anthropic-beta: oauth-2025-04-20" \
        -D "$header_file" \
        -w '\n%{http_code}' \
        "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)

    # 마지막 줄 = HTTP 상태코드, 나머지 = 응답 본문
    http_code="${body##*$'\n'}"
    body="${body%$'\n'*}"

    if [ "$http_code" = "429" ]; then
        local retry_after
        retry_after=$(grep -i 'retry-after' "$header_file" 2>/dev/null | head -1 | tr -d '\r' | awk '{print $2}')
        if [ -n "$retry_after" ] && [ "$retry_after" -gt 0 ] 2>/dev/null; then
            write_lock $((now + retry_after))
        else
            write_lock $((now + USAGE_RATE_LIMIT_BACKOFF))
        fi
        rm -f "$header_file"
        return 1
    fi

    rm -f "$header_file"

    [ "$http_code" != "200" ] || [ -z "$body" ] && return 1

    # 응답 검증
    local valid
    valid=$(echo "$body" | jq -r '[.five_hour.utilization, .seven_day.utilization] | any(. != null)' 2>/dev/null)
    [ "$valid" = "true" ] || return 1

    echo "$body" > "$USAGE_CACHE_FILE"
    return 0
}

# 사용량 데이터 읽기 (캐시 우선, 필요 시 API 호출)
get_usage_data() {
    local cache_age
    if cache_age=$(get_file_age "$USAGE_CACHE_FILE") 2>/dev/null; then
        if [ "$cache_age" -lt "$USAGE_CACHE_MAX_AGE" ]; then
            cat "$USAGE_CACHE_FILE"
            return 0
        fi
    fi

    fetch_and_cache_usage

    if [ -f "$USAGE_CACHE_FILE" ]; then
        cat "$USAGE_CACHE_FILE"
        return 0
    fi

    return 1
}

# 퍼센트 값에 따른 색상 반환 (결과를 _color 변수에 설정)
# 사용법: set_color_by_pct <pct> <low_threshold> <high_threshold>
#   low 미만=초록, low~high=노랑, high 이상=빨강
set_color_by_pct() {
    local pct="${1%.*}" low="$2" high="$3"
    if [ "$pct" -lt "$low" ] 2>/dev/null; then
        _color="$C_GREEN"
    elif [ "$pct" -lt "$high" ] 2>/dev/null; then
        _color="$C_YELLOW"
    else
        _color="$C_RED"
    fi
}

# ── 메인 로직 ──

# 캐시 디렉토리 미리 생성 (mkdir 중복 호출 방지)
mkdir -p "$USAGE_CACHE_DIR"

# 표준 입력으로부터 JSON 데이터 읽기
input=$(cat)

# JSON에서 필요한 정보를 한 번에 추출
IFS=$'\t' read -r model cwd context_window_size input_tokens cache_creation cache_read <<< \
    "$(echo "$input" | jq -r '[
        .model.display_name,
        .workspace.current_dir,
        (.context_window.context_window_size // 0),
        (.context_window.current_usage.input_tokens // 0),
        (.context_window.current_usage.cache_creation_input_tokens // 0),
        (.context_window.current_usage.cache_read_input_tokens // 0)
    ] | @tsv')"

dir=$(basename "$cwd")
cd "$cwd" 2>/dev/null || cd ~

# 출력 세그먼트를 두 줄로 수집
# line1: 컨텍스트 (모델, 위치, git)
# line2: 메트릭 (연료, API 사용량)
line1_segments=()
line2_segments=()
line1_segments+=("🤖 ${C_CYAN}${model}${C_RESET}")
line1_segments+=("📁 ${C_BLUE}${dir}${C_RESET}")

# ── Git 상태 ──
if git rev-parse --git-dir >/dev/null 2>&1; then
    git_cmd="git -c gc.autodetach=false"

    br=$($git_cmd symbolic-ref --short HEAD 2>/dev/null || \
         $git_cmd rev-parse --short HEAD 2>/dev/null)

    if [ -n "$br" ]; then
        st=""
        $git_cmd diff --quiet >/dev/null 2>&1 || st="${C_RED}●${C_RESET}"
        $git_cmd diff --cached --quiet >/dev/null 2>&1 || st="${st}${C_GREEN}●${C_RESET}"
        [ -n "$($git_cmd ls-files --others --exclude-standard 2>/dev/null)" ] && \
            st="${st}${C_YELLOW}●${C_RESET}"
        [ -z "$st" ] && st="${C_GREEN}✓${C_RESET}"

        line1_segments+=("🌿 ${C_MAGENTA}${br}${C_RESET} ${st}")
    fi
fi

# ── 연료 게이지 (토큰 사용량) ──
current_usage=$((input_tokens + cache_creation + cache_read))

if [ "$current_usage" -gt 0 ] 2>/dev/null; then
    settings_file="$HOME/.claude.json"
    if [ -f "$settings_file" ]; then
        autocompact_enabled=$(jq -r 'if .autoCompactEnabled == null then true else .autoCompactEnabled end' "$settings_file" 2>/dev/null)
    else
        autocompact_enabled=true
    fi

    # Autocompact 버퍼: ON=33K 고정, OFF=3K 고정
    if [ "$autocompact_enabled" = "true" ]; then
        autocompact_buffer=33000
    else
        autocompact_buffer=3000
    fi

    safe_limit=$((context_window_size - autocompact_buffer))
    fuel_remaining=$((safe_limit - current_usage))

    if [ "$safe_limit" -gt 0 ] && [ "$fuel_remaining" -ge 0 ]; then
        fuel_pct=$(( (fuel_remaining * 100 + safe_limit / 2) / safe_limit ))
    else
        fuel_pct=0
    fi

    # 연료 게이지: 역방향 (높을수록 좋음) → 임계값 반전
    if [ "$fuel_pct" -ge 70 ]; then
        fuel_color="$C_GREEN"; fuel_icon="⛽"
    elif [ "$fuel_pct" -ge 30 ]; then
        fuel_color="$C_YELLOW"; fuel_icon="⛽"
    else
        fuel_color="$C_RED"; fuel_icon="⚠️"
    fi

    if [ "$fuel_remaining" -gt 1000 ]; then
        fuel_display="$((fuel_remaining / 1000))K"
    else
        fuel_display="$fuel_remaining"
    fi

    line2_segments+=("${fuel_icon} ${fuel_color}${fuel_pct}%${C_RESET} ${C_DIM}(${fuel_display})${C_RESET}")
fi

# ── API 사용량 ──
usage_json=$(get_usage_data 2>/dev/null)
if [ -n "$usage_json" ]; then
    IFS=$'\t' read -r session_pct weekly_pct <<< \
        "$(echo "$usage_json" | jq -r '[
            (.five_hour.utilization // -1),
            (.seven_day.utilization // -1)
        ] | @tsv' 2>/dev/null)"

    if [ "${session_pct%.*}" -ge 0 ] 2>/dev/null || [ "${weekly_pct%.*}" -ge 0 ] 2>/dev/null; then
        usage_parts=""

        if [ "${session_pct%.*}" -ge 0 ] 2>/dev/null; then
            set_color_by_pct "$session_pct" 50 80
            s_display=$(printf "%.0f" "$session_pct" 2>/dev/null || echo "$session_pct")
            usage_parts="5h ${_color}${s_display}%${C_RESET}"
        fi

        if [ "${weekly_pct%.*}" -ge 0 ] 2>/dev/null; then
            set_color_by_pct "$weekly_pct" 50 80
            w_display=$(printf "%.0f" "$weekly_pct" 2>/dev/null || echo "$weekly_pct")
            if [ -n "$usage_parts" ]; then
                usage_parts="${usage_parts} · 7d ${_color}${w_display}%${C_RESET}"
            else
                usage_parts="7d ${_color}${w_display}%${C_RESET}"
            fi
        fi

        line2_segments+=("📊 ${usage_parts}")
    fi
fi

# ── 최종 출력: 각 줄의 세그먼트를 구분자로 연결 ──
join_segments() {
    local out=""
    for seg in "$@"; do
        if [ -n "$out" ]; then
            out="${out}${SEP}${seg}"
        else
            out="$seg"
        fi
    done
    echo "$out"
}

printf "%b\n" "$(join_segments "${line1_segments[@]}")"
if [ "${#line2_segments[@]}" -gt 0 ]; then
    printf "%b\n" "$(join_segments "${line2_segments[@]}")"
fi
