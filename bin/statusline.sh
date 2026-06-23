#!/bin/bash
# Statusline script for Claude Code

# ── ANSI color constants ──
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

# ── OS detection (single uname call) ──
readonly IS_DARWIN=$([ "$(uname)" = "Darwin" ] && echo 1)

# ── API usage config ──
readonly USAGE_API_URL="https://api.anthropic.com/api/oauth/usage"
readonly USAGE_CACHE_DIR="$HOME/.cache/byj-cc-statusline"
readonly USAGE_CACHE_FILE="$USAGE_CACHE_DIR/usage.json"   # response payload (mtime = last successful fetch)
readonly USAGE_LOCK_DIR="$USAGE_CACHE_DIR/usage.lock.d"   # atomic single-flight lock (mkdir)
readonly USAGE_STATE_FILE="$USAGE_CACHE_DIR/usage.state"  # cooldown / failure count / last diagnostics
readonly USAGE_CACHE_TTL=180          # serve cache without refetch within this window (seconds)
readonly USAGE_LOCK_STALE=60          # reclaim a lock older than this as a dead holder (seconds)
readonly USAGE_BACKOFF_BASE=30        # exponential backoff base (seconds)
readonly USAGE_BACKOFF_CAP=300        # cap for every backoff — Retry-After is capped here too (seconds)
readonly USAGE_API_TIMEOUT=4          # curl timeout; single-flight means blocking at most once per TTL

# ── Utility functions ──

# Return the age of a file in seconds
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

# ── Single-flight lock (atomic mkdir; portable across macOS/Linux) ──
# Prevents concurrent renders from hitting the API at once (which triggers 429).
# Unlike check-then-write, mkdir is atomic so there is no race.

# Acquire the lock (0 = success). Reclaims a stale lock left by a dead holder.
acquire_lock() {
    mkdir "$USAGE_LOCK_DIR" 2>/dev/null && return 0
    local age
    age=$(get_file_age "$USAGE_LOCK_DIR") || return 1
    if [ "$age" -gt "$USAGE_LOCK_STALE" ] 2>/dev/null; then
        rm -rf "$USAGE_LOCK_DIR" 2>/dev/null
        mkdir "$USAGE_LOCK_DIR" 2>/dev/null && return 0
    fi
    return 1
}

release_lock() {
    rmdir "$USAGE_LOCK_DIR" 2>/dev/null
}

# ── Cooldown / diagnostic state (separate from the lock: "when may we retry") ──
# Set only after an error. Also records the last code/reason for diagnostics.

# Returns 0 (blocked) while in cooldown
in_cooldown() {
    [ -f "$USAGE_STATE_FILE" ] || return 1
    local now until
    now=$(date +%s)
    until=$(jq -r '.cooldownUntil // 0' "$USAGE_STATE_FILE" 2>/dev/null)
    [ "$until" -gt "$now" ] 2>/dev/null
}

# Record state: <http_code> <reason> <cooldown_sec> <failures>
write_state() {
    local now; now=$(date +%s)
    jq -nc \
        --argjson until "$(( now + $3 ))" --argjson fails "$4" \
        --arg code "$1" --arg reason "$2" --argjson at "$now" \
        '{cooldownUntil:$until, failures:$fails, lastCode:$code, reason:$reason, at:$at}' \
        > "$USAGE_STATE_FILE" 2>/dev/null
}

# Reset cooldown / failure count on success
clear_state() {
    local now; now=$(date +%s)
    jq -nc --argjson at "$now" \
        '{cooldownUntil:0, failures:0, lastCode:"200", reason:"ok", at:$at}' \
        > "$USAGE_STATE_FILE" 2>/dev/null
}

# Next backoff (seconds): exponential growth + jitter, capped → a freeze can't span days
backoff_seconds() {
    local fails="$1"
    [ "$fails" -lt 1 ] 2>/dev/null && fails=1
    [ "$fails" -gt 8 ] 2>/dev/null && fails=8       # guard against shift overflow
    local d=$(( USAGE_BACKOFF_BASE << (fails - 1) ))
    [ "$d" -gt "$USAGE_BACKOFF_CAP" ] && d=$USAGE_BACKOFF_CAP
    echo $(( d + RANDOM % (USAGE_BACKOFF_BASE / 2 + 1) ))
}

# Get the OAuth token (macOS Keychain first, then credentials file)
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

# Validate the response (passes if either 5h or 7d has a value)
validate_usage() {
    [ -n "$1" ] || return 1
    local ok
    ok=$(printf '%s' "$1" | jq -r '[.five_hour.utilization, .seven_day.utilization] | any(. != null)' 2>/dev/null)
    [ "$ok" = "true" ]
}

# Extract Retry-After (seconds) from the response headers
parse_retry_after() {
    grep -i 'retry-after' "$1" 2>/dev/null | head -1 | tr -d '\r' | awk '{print $2}'
}

# Perform the HTTP call and update cache/cooldown from the result. Call only while holding the lock.
# Args: <token>. Returns 0 if the cache was updated.
_do_fetch() {
    local token="$1" header_file body http_code retry_after fails cd
    header_file=$(mktemp)
    body=$(curl -s --max-time "$USAGE_API_TIMEOUT" \
        -H "Authorization: Bearer $token" \
        -H "anthropic-beta: oauth-2025-04-20" \
        -D "$header_file" \
        -w '\n%{http_code}' \
        "$USAGE_API_URL" 2>/dev/null)

    # last line = HTTP status code, the rest = response body
    http_code="${body##*$'\n'}"
    body="${body%$'\n'*}"

    # Success: write cache + reset cooldown/failures → recover the moment the API is healthy
    if [ "$http_code" = "200" ] && validate_usage "$body"; then
        printf '%s' "$body" > "$USAGE_CACHE_FILE"
        clear_state
        rm -f "$header_file"
        return 0
    fi

    # Failure: bump the failure count, then set a capped cooldown
    fails=$(jq -r '.failures // 0' "$USAGE_STATE_FILE" 2>/dev/null)
    case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
    fails=$((fails + 1))

    if [ "$http_code" = "429" ]; then
        retry_after=$(parse_retry_after "$header_file")
        if [ -n "$retry_after" ] && [ "$retry_after" -gt 0 ] 2>/dev/null; then
            cd=$retry_after
            [ "$cd" -gt "$USAGE_BACKOFF_CAP" ] && cd=$USAGE_BACKOFF_CAP   # prevent a 1-hour Retry-After from freezing us
        else
            cd=$(backoff_seconds "$fails")
        fi
        write_state "429" "rate-limited(retry=${retry_after:-none};cooldown=${cd})" "$cd" "$fails"
    else
        cd=$(backoff_seconds "$fails")
        write_state "${http_code:-000}" "fetch-failed(http=${http_code:-timeout})" "$cd" "$fails"
    fi
    rm -f "$header_file"
    return 1
}

# Fetch orchestration: token → cooldown → lock → call → release lock
fetch_usage() {
    local token
    token=$(get_usage_token)
    [ -z "$token" ] && { write_state "000" "no-token" "$USAGE_BACKOFF_CAP" 0; return 1; }

    in_cooldown && return 1
    acquire_lock || return 1   # yield immediately if another render is already fetching (show cache instead)

    _do_fetch "$token"
    local rc=$?
    release_lock
    return $rc
}

# Read usage data (cache first, single-flight fetch when needed).
# Always prints whatever cache we have — even on a failed refresh, the screen shows something.
get_usage_data() {
    local age
    age=$(get_file_age "$USAGE_CACHE_FILE")
    if [ -n "$age" ] && [ "$age" -lt "$USAGE_CACHE_TTL" ] 2>/dev/null; then
        cat "$USAGE_CACHE_FILE"
        return 0
    fi

    fetch_usage   # stale/missing → try to refresh (lock & cooldown throttle the call rate)

    if [ -f "$USAGE_CACHE_FILE" ]; then
        cat "$USAGE_CACHE_FILE"
        return 0
    fi
    return 1
}

# Return a color based on a percentage (sets the _color variable)
# Usage: set_color_by_pct <pct> <low_threshold> <high_threshold>
#   below low = green, low..high = yellow, at/above high = red
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

# Render one usage window — if the window already reset (resets_at passed), show stale as dim+'~'.
# Args: <label> <pct> <resets_at>. Prints the segment and returns 0 if valid, else 1.
# resets_at is always '...+00:00' (UTC), so a lexicographic compare with NOW_UTC works (no date -d).
render_usage_window() {
    local label="$1" pct="$2" reset="$3" disp
    [ "${pct%.*}" -ge 0 ] 2>/dev/null || return 1
    disp=$(printf "%.0f" "$pct" 2>/dev/null || echo "$pct")
    if [ -n "$reset" ] && [ "$reset" != "null" ] && [[ "$NOW_UTC" > "${reset:0:19}" ]]; then
        printf '%s%s ~%s%%%s' "$C_DIM" "$label" "$disp" "$C_RESET"
    else
        set_color_by_pct "$pct" 50 80
        printf '%s %s%s%%%s' "$label" "$_color" "$disp" "$C_RESET"
    fi
}

# ── Diagnostics (DX): `statusline.sh --doctor` ──
# Dumps cache/lock/cooldown/token state at once and tests a live fetch.
# A one-command tool to diagnose why usage stops updating.
run_doctor() {
    local now now_utc age r5 r7 token
    now=$(date +%s); now_utc=$(date -u +%Y-%m-%dT%H:%M:%S)
    echo "byj-cc-statusline doctor"
    echo "platform : $(uname)  bash ${BASH_VERSION}"
    echo "now      : $now  ($now_utc UTC)"
    echo

    echo "[cache] $USAGE_CACHE_FILE"
    if age=$(get_file_age "$USAGE_CACHE_FILE"); then
        echo "  age    : ${age}s (TTL ${USAGE_CACHE_TTL}s) -> $([ "$age" -lt "$USAGE_CACHE_TTL" ] 2>/dev/null && echo fresh || echo STALE)"
        jq -r '"  5h     : \(.five_hour.utilization)%  resets \(.five_hour.resets_at)",
               "  7d     : \(.seven_day.utilization)%  resets \(.seven_day.resets_at)"' \
            "$USAGE_CACHE_FILE" 2>/dev/null
        r5=$(jq -r '.five_hour.resets_at  // ""' "$USAGE_CACHE_FILE" 2>/dev/null)
        r7=$(jq -r '.seven_day.resets_at // ""' "$USAGE_CACHE_FILE" 2>/dev/null)
        [ -n "$r5" ] && echo "  5h win : $([[ "$now_utc" > "${r5:0:19}" ]] && echo 'EXPIRED (shown dim ~)' || echo valid)"
        [ -n "$r7" ] && echo "  7d win : $([[ "$now_utc" > "${r7:0:19}" ]] && echo 'EXPIRED (shown dim ~)' || echo valid)"
    else
        echo "  (no cache file yet)"
    fi
    echo

    echo "[lock] $USAGE_LOCK_DIR"
    if [ -d "$USAGE_LOCK_DIR" ]; then
        age=$(get_file_age "$USAGE_LOCK_DIR")
        echo "  held   : yes, age ${age:-?}s ($([ "${age:-0}" -gt "$USAGE_LOCK_STALE" ] 2>/dev/null && echo 'STALE -> reclaimable' || echo active))"
    else
        echo "  held   : no"
    fi
    echo

    echo "[state] $USAGE_STATE_FILE"
    if [ -f "$USAGE_STATE_FILE" ]; then
        local until
        until=$(jq -r '.cooldownUntil // 0' "$USAGE_STATE_FILE" 2>/dev/null)
        jq -r '"  lastCode: \(.lastCode)   failures: \(.failures)   reason: \(.reason)"' "$USAGE_STATE_FILE" 2>/dev/null
        if [ "$until" -gt "$now" ] 2>/dev/null; then
            echo "  cooldown: ACTIVE for $((until - now))s more"
        else
            echo "  cooldown: none"
        fi
    else
        echo "  (no state file yet)"
    fi
    echo

    echo "[token]"
    token=$(get_usage_token)
    if [ -n "$token" ]; then echo "  present : yes (len ${#token})"
    else echo "  present : NO -> usage cannot be fetched"; fi
    echo

    echo "[live fetch test] $USAGE_API_URL  (read-only; does not touch cache/lock/cooldown)"
    if [ -n "$token" ]; then
        local t0 t1 hc body
        t0=$(date +%s)
        body=$(curl -s --max-time "$USAGE_API_TIMEOUT" \
            -H "Authorization: Bearer $token" \
            -H "anthropic-beta: oauth-2025-04-20" \
            -w '\n%{http_code}' "$USAGE_API_URL" 2>/dev/null)
        t1=$(date +%s)
        hc="${body##*$'\n'}"; body="${body%$'\n'*}"
        echo "  http    : ${hc:-no-response}  ($((t1 - t0))s)"
        echo "  parsed  : $(printf '%s' "$body" | jq -rc '{five_h:.five_hour.utilization, seven_d:.seven_day.utilization}' 2>/dev/null)"
    else
        echo "  skipped (no token)"
    fi
}

# ── Main logic ──

# Pre-create the cache dir (avoid repeated mkdir calls)
mkdir -p "$USAGE_CACHE_DIR"
rm -f "$USAGE_CACHE_DIR/usage.lock" 2>/dev/null   # legacy: clean up the old single lock file

# Diagnostic mode: `statusline.sh --doctor` (no stdin needed)
if [ "${1:-}" = "--doctor" ]; then
    run_doctor
    exit 0
fi

# Read JSON data from stdin
input=$(cat)

# Extract the needed fields from JSON in one pass
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

# Collect output segments into two lines
# line1: context (model, location, git)
# line2: metrics (fuel, API usage)
line1_segments=()
line2_segments=()
line1_segments+=("🤖 ${C_CYAN}${model}${C_RESET}")
line1_segments+=("📁 ${C_BLUE}${dir}${C_RESET}")

# ── Git status ──
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

# ── Fuel gauge (token usage) ──
current_usage=$((input_tokens + cache_creation + cache_read))

if [ "$current_usage" -gt 0 ] 2>/dev/null; then
    settings_file="$HOME/.claude.json"
    if [ -f "$settings_file" ]; then
        autocompact_enabled=$(jq -r 'if .autoCompactEnabled == null then true else .autoCompactEnabled end' "$settings_file" 2>/dev/null)
    else
        autocompact_enabled=true
    fi

    # Autocompact buffer: ON = fixed 33K, OFF = fixed 3K
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

    # Fuel gauge: reversed (higher is better) → thresholds inverted
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

# ── API usage ──
usage_json=$(get_usage_data 2>/dev/null)
if [ -n "$usage_json" ]; then
    NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%S)   # for lexicographic compare against resets_at (UTC); portable, avoids date -d

    IFS=$'\t' read -r session_pct session_reset weekly_pct weekly_reset <<< \
        "$(printf '%s' "$usage_json" | jq -r '[
            (.five_hour.utilization  // -1),
            (.five_hour.resets_at    // ""),
            (.seven_day.utilization  // -1),
            (.seven_day.resets_at    // "")
        ] | @tsv' 2>/dev/null)"

    usage_parts=""
    seg=$(render_usage_window "5h" "$session_pct" "$session_reset") && usage_parts="$seg"
    seg=$(render_usage_window "7d" "$weekly_pct" "$weekly_reset") && \
        usage_parts="${usage_parts:+$usage_parts · }$seg"

    [ -n "$usage_parts" ] && line2_segments+=("📊 ${usage_parts}")
fi

# ── Final output: join each line's segments with the separator ──
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
