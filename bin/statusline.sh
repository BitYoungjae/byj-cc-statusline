#!/bin/bash
# Claude Code 상태 라인을 표시하는 스크립트

# 표준 입력으로부터 JSON 데이터 읽기
input=$(cat)

# JSON에서 필요한 정보를 한 번에 추출 (jq 호출 최적화)
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

# 작업 디렉토리로 이동 (실패 시 홈 디렉토리로)
cd "$cwd" 2>/dev/null || cd ~

# 기본 출력 구성: 모델명과 디렉토리명
out="🤖 \033[36m${model}\033[0m \033[1m|\033[0m 📁 \033[34m${dir}\033[0m"

# Git 저장소 체크 및 브랜치 정보 추가
if git rev-parse --git-dir >/dev/null 2>&1; then
    git_cmd="git -c gc.autodetach=false"

    # 현재 브랜치명 또는 커밋 해시 가져오기
    br=$($git_cmd symbolic-ref --short HEAD 2>/dev/null || \
         $git_cmd rev-parse --short HEAD 2>/dev/null)

    if [ -n "$br" ]; then
        st=""

        # 작업 디렉토리에 수정된 파일이 있는지 체크 (빨간색 점)
        $git_cmd diff --quiet >/dev/null 2>&1 || st="\033[31m●\033[0m"

        # 스테이징된 파일이 있는지 체크 (초록색 점)
        $git_cmd diff --cached --quiet >/dev/null 2>&1 || st="${st}\033[32m●\033[0m"

        # 추적되지 않는 파일이 있는지 체크 (노란색 점)
        [ -n "$($git_cmd ls-files --others --exclude-standard 2>/dev/null)" ] && \
            st="${st}\033[33m●\033[0m"

        # 모든 변경사항이 없으면 초록색 체크 표시
        [ -z "$st" ] && st="\033[32m✓\033[0m"

        # 출력에 Git 정보 추가
        out="${out} \033[1m|\033[0m 🌿 \033[35m${br}\033[0m ${st}"
    fi
fi

# 토큰 사용량 계산 및 연료 게이지 표시 (Claude Code 2.0.65+)
current_usage=$((input_tokens + cache_creation + cache_read))

if [ "$current_usage" -gt 0 ] 2>/dev/null; then
    # autoCompactEnabled 설정 확인 (기본값: true)
    settings_file="$HOME/.claude.json"
    if [ -f "$settings_file" ]; then
        autocompact_enabled=$(jq -r 'if .autoCompactEnabled == null then true else .autoCompactEnabled end' "$settings_file" 2>/dev/null)
    else
        autocompact_enabled=true
    fi

    # Autocompact 버퍼 계산 (전체의 22.5%)
    if [ "$autocompact_enabled" = "true" ]; then
        autocompact_buffer=$((context_window_size * 225 / 1000))
    else
        autocompact_buffer=0
    fi

    safe_limit=$((context_window_size - autocompact_buffer))
    fuel_remaining=$((safe_limit - current_usage))

    # 남은 여유의 백분율 (반올림)
    if [ "$safe_limit" -gt 0 ] && [ "$fuel_remaining" -ge 0 ]; then
        fuel_pct=$(( (fuel_remaining * 100 + safe_limit / 2) / safe_limit ))
    else
        fuel_pct=0
    fi

    # 연료 게이지 색상과 아이콘
    if [ "$fuel_pct" -ge 70 ]; then
        fuel_color="\033[32m"; fuel_icon="⛽"
    elif [ "$fuel_pct" -ge 30 ]; then
        fuel_color="\033[33m"; fuel_icon="⛽"
    else
        fuel_color="\033[31m"; fuel_icon="⚠️"
    fi

    # 남은 토큰 수 포맷팅
    if [ "$fuel_remaining" -gt 1000 ]; then
        fuel_display="$((fuel_remaining / 1000))K"
    else
        fuel_display="$fuel_remaining"
    fi

    out="${out} \033[1m|\033[0m ${fuel_icon} ${fuel_color}${fuel_pct}%\033[0m \033[2m(${fuel_display})\033[0m"
fi

printf "%b\n" "$out"
