#!/bin/bash
# Claude Code 상태 라인을 표시하는 스크립트

# 표준 입력으로부터 JSON 데이터 읽기
input=$(cat)

# JSON에서 필요한 정보 추출
model=$(echo "$input" | jq -r '.model.display_name')
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
transcript=$(echo "$input" | jq -r '.transcript_path')
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
if [ -f "$transcript" ] && command -v jq >/dev/null 2>&1; then
    # JSONL 파일에서 가장 최근 usage 정보 추출
    usage_json=$(tail -n 100 "$transcript" | \
        jq -r 'select(.message.usage != null) |
               .message.usage |
               "\(.input_tokens + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)) \(.output_tokens)"' 2>/dev/null | \
        tail -1)

    if [ -n "$usage_json" ]; then
        # 입력 토큰과 출력 토큰 추출
        input_tokens=$(echo "$usage_json" | awk '{print $1}')
        output_tokens=$(echo "$usage_json" | awk '{print $2}')

        if [ -n "$input_tokens" ] && [ -n "$output_tokens" ]; then
            # 토큰 예산 설정
            TOTAL_BUDGET=200000           # 전체 컨텍스트 크기

            # autoCompactEnabled 설정 확인 (기본값: true)
            SETTINGS_FILE="$HOME/.claude/settings.json"
            if [ -f "$SETTINGS_FILE" ]; then
                autocompact_enabled=$(jq -r 'if .autoCompactEnabled == null then true else .autoCompactEnabled end' "$SETTINGS_FILE" 2>/dev/null)
            else
                autocompact_enabled=true
            fi

            # Autocompact 활성화 여부에 따라 버퍼 설정
            if [ "$autocompact_enabled" = "true" ]; then
                AUTOCOMPACT_BUFFER=45000      # Autocompact 버퍼 (22.5%)
            else
                AUTOCOMPACT_BUFFER=0          # Autocompact 비활성화 시 버퍼 없음
            fi

            SAFE_LIMIT=$((TOTAL_BUDGET - AUTOCOMPACT_BUFFER))  # 안전 한계

            # 현재 사용량 계산
            current_usage=$((input_tokens + output_tokens))

            # Autocompact 발동까지 남은 여유 계산 (연료 게이지)
            fuel_remaining=$((SAFE_LIMIT - current_usage))

            # 남은 여유의 백분율 (155k 기준, 반올림)
            if [ "$SAFE_LIMIT" -gt 0 ] && [ "$fuel_remaining" -ge 0 ]; then
                # 반올림: (a * 100 + b/2) / b
                fuel_pct=$(( (fuel_remaining * 100 + SAFE_LIMIT / 2) / SAFE_LIMIT ))
            else
                fuel_pct=0  # 이미 한계 초과
            fi

            # 연료 게이지 표시: 남은 여유에 따라 색상과 아이콘 변경
            if [ "$fuel_pct" -ge 70 ]; then
                # 🟢 충분 (70%+)
                fuel_color="\033[32m"  # 초록색
                fuel_icon="⛽"
            elif [ "$fuel_pct" -ge 30 ]; then
                # 🟡 보통 (30-70%)
                fuel_color="\033[33m"  # 노란색
                fuel_icon="⛽"
            else
                # 🔴 주의 (30% 미만)
                fuel_color="\033[31m"  # 빨간색
                fuel_icon="⚠️"
            fi

            # 남은 토큰 수 포맷팅
            if [ "$fuel_remaining" -gt 1000 ]; then
                fuel_display="$((fuel_remaining / 1000))K"
            else
                fuel_display="$fuel_remaining"
            fi

            # 연료 게이지 출력: 아이콘 퍼센트 (토큰수)
            out="${out} \033[1m|\033[0m ${fuel_icon} ${fuel_color}${fuel_pct}%\033[0m \033[2m(${fuel_display})\033[0m"
        fi
    fi
fi

# 최종 결과 출력
printf "%b\n" "$out"
