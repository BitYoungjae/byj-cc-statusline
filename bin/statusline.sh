#!/bin/bash
# Claude Code 상태 라인을 표시하는 스크립트

# 표준 입력으로부터 JSON 데이터 읽기
input=$(cat)

# JSON에서 필요한 정보 추출
model=$(echo "$input" | jq -r '.model.display_name')
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
dir=$(basename "$cwd")

# 작업 디렉토리로 이동 (실패 시 홈 디렉토리로)
cd "$cwd" 2>/dev/null || cd ~

# 기본 출력 구성: 모델명과 디렉토리명
out="🤖 \033[36m${model}\033[0m \033[1m|\033[0m 📁 \033[34m${dir}\033[0m"

# Git 저장소 체크 및 브랜치 정보 추가
if git rev-parse --git-dir >/dev/null 2>&1; then
    # 현재 브랜치명 또는 커밋 해시 가져오기
    br=$(git -c gc.autodetach=false symbolic-ref --short HEAD 2>/dev/null || \
         git -c gc.autodetach=false rev-parse --short HEAD 2>/dev/null)

    if [ -n "$br" ]; then
        st=""

        # 작업 디렉토리에 수정된 파일이 있는지 체크 (빨간색 점)
        git -c gc.autodetach=false diff --quiet >/dev/null 2>&1 || st="\033[31m●\033[0m"

        # 스테이징된 파일이 있는지 체크 (초록색 점)
        git -c gc.autodetach=false diff --cached --quiet >/dev/null 2>&1 || st="${st}\033[32m●\033[0m"

        # 추적되지 않는 파일이 있는지 체크 (노란색 점)
        [ -n "$(git -c gc.autodetach=false ls-files --others --exclude-standard 2>/dev/null)" ] && \
            st="${st}\033[33m●\033[0m"

        # 모든 변경사항이 없으면 초록색 체크 표시
        [ -z "$st" ] && st="\033[32m✓\033[0m"

        # 출력에 Git 정보 추가
        out="${out} \033[1m|\033[0m 🌿 \033[35m${br}\033[0m ${st}"
    fi
fi

# 토큰 사용량 정보 추출 및 표시 (연료 게이지 스타일)
# stdin의 context_window 데이터 사용 (Claude Code 2.0.65+)

current_usage=0
TOTAL_BUDGET=200000  # 기본값
context_window_size=$(echo "$input" | jq -r '.context_window.context_window_size // 0')
current_usage_json=$(echo "$input" | jq '.context_window.current_usage // null')

if [ "$context_window_size" -gt 0 ] 2>/dev/null && [ "$current_usage_json" != "null" ]; then
    TOTAL_BUDGET=$context_window_size

    # 토큰 추출 (output_tokens 제외 - 컨텍스트 윈도우는 입력 기준)
    input_tokens=$(echo "$current_usage_json" | jq -r '.input_tokens // 0')
    cache_creation=$(echo "$current_usage_json" | jq -r '.cache_creation_input_tokens // 0')
    cache_read=$(echo "$current_usage_json" | jq -r '.cache_read_input_tokens // 0')

    current_usage=$((input_tokens + cache_creation + cache_read))
fi

# 토큰 사용량이 있을 때만 연료 게이지 표시
if [ "$current_usage" -gt 0 ] 2>/dev/null; then
    # autoCompactEnabled 설정 확인 (기본값: true)
    SETTINGS_FILE="$HOME/.claude.json"
    if [ -f "$SETTINGS_FILE" ]; then
        autocompact_enabled=$(jq -r 'if .autoCompactEnabled == null then true else .autoCompactEnabled end' "$SETTINGS_FILE" 2>/dev/null)
    else
        autocompact_enabled=true
    fi

    # Autocompact 버퍼를 동적으로 계산 (전체의 22.5%)
    if [ "$autocompact_enabled" = "true" ]; then
        AUTOCOMPACT_BUFFER=$((TOTAL_BUDGET * 225 / 1000))
    else
        AUTOCOMPACT_BUFFER=0
    fi

    SAFE_LIMIT=$((TOTAL_BUDGET - AUTOCOMPACT_BUFFER))

    # Autocompact 발동까지 남은 여유 계산 (연료 게이지)
    fuel_remaining=$((SAFE_LIMIT - current_usage))

    # 남은 여유의 백분율 (SAFE_LIMIT 기준, 반올림)
    if [ "$SAFE_LIMIT" -gt 0 ] && [ "$fuel_remaining" -ge 0 ]; then
        fuel_pct=$(( (fuel_remaining * 100 + SAFE_LIMIT / 2) / SAFE_LIMIT ))
    else
        fuel_pct=0
    fi

    # 연료 게이지 표시: 남은 여유에 따라 색상과 아이콘 변경
    if [ "$fuel_pct" -ge 70 ]; then
        fuel_color="\033[32m"  # 초록색
        fuel_icon="⛽"
    elif [ "$fuel_pct" -ge 30 ]; then
        fuel_color="\033[33m"  # 노란색
        fuel_icon="⛽"
    else
        fuel_color="\033[31m"  # 빨간색
        fuel_icon="⚠️"
    fi

    # 남은 토큰 수 포맷팅
    if [ "$fuel_remaining" -gt 1000 ]; then
        fuel_display="$((fuel_remaining / 1000))K"
    else
        fuel_display="$fuel_remaining"
    fi

    # 연료 게이지 출력
    out="${out} \033[1m|\033[0m ${fuel_icon} ${fuel_color}${fuel_pct}%\033[0m \033[2m(${fuel_display})\033[0m"
fi

# 최종 결과 출력
printf "%b\n" "$out"
