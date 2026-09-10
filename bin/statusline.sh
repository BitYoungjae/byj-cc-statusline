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

# ── Rate limit config ──
# Claude Code hands us the 5h/7d windows on stdin as .rate_limits, so nothing
# here touches the network: no OAuth token, no curl, no single-flight lock, no
# backoff. The cache exists only to bridge the start of a session (see below).
readonly USAGE_CACHE_DIR="$HOME/.cache/byj-cc-statusline"
readonly RATE_LIMIT_CACHE="$USAGE_CACHE_DIR/rate-limits.json"

# ── Session registry (cross-session messaging names) ──
readonly SESSION_REGISTRY_DIR="$HOME/.claude/sessions"

# ── Utility functions ──

# Return the age (seconds) of a file *or directory* (-e, not -f).
get_file_age() {
    local file="$1"
    [ -e "$file" ] || return 1
    local now mtime
    now=$(date +%s)
    if [ -n "$IS_DARWIN" ]; then
        mtime=$(stat -f %m "$file" 2>/dev/null) || return 1
    else
        mtime=$(stat -c %Y "$file" 2>/dev/null) || return 1
    fi
    echo $((now - mtime))
}

# ── Session identity ──
# The name other sessions address in cross-session messaging is NOT the stdin
# `session_name` field (that is the conversation title, e.g. "Fix the fuel
# gauge" — not addressable). The messaging name lives in the session registry:
# one JSON file per live session, named by pid, keyed internally by sessionId.
get_session_name() {
    local sid="$1"
    [ -n "$sid" ] || return 1
    [ -d "$SESSION_REGISTRY_DIR" ] || return 1

    # grep first: it narrows to the one matching file without parsing, so a
    # registry file caught mid-write can't break the lookup for every session.
    local -a matches=()
    local f
    while IFS= read -r f; do
        matches+=("$f")
    done < <(grep -l -- "$sid" "$SESSION_REGISTRY_DIR"/*.json 2>/dev/null)
    [ "${#matches[@]}" -gt 0 ] || return 1

    # Match on sessionId (not the filename): grep only proved the id appears
    # somewhere in the file. A resumed session can leave the previous pid's
    # file behind, so the most recently updated entry wins.
    #
    # One jq per file rather than one slurped call over all of them: a single
    # file left truncated by a session killed mid-write makes jq reject its
    # whole input, which would hide the name for as long as that file sits
    # there. Read separately, a bad file costs only itself.
    local best_name="" best_ts=-1 name ts
    for f in "${matches[@]}"; do
        IFS=$'\037' read -r name ts <<< "$(jq -r --arg sid "$sid" \
            'select(.sessionId == $sid)
             | [(.name // ""), (.updatedAt // 0)] | map(tostring) | join("\u001f")' \
            "$f" 2>/dev/null)"
        [ -n "$name" ] || continue
        case "$ts" in ''|*[!0-9]*) ts=0 ;; esac
        if [ "$ts" -ge "$best_ts" ]; then
            best_name="$name"
            best_ts="$ts"
        fi
    done

    [ -n "$best_name" ] || return 1
    printf '%s' "$best_name"
}

# ── Rate limits (5h / 7d) ──
# The source of truth is stdin. Claude Code keeps these windows in memory,
# refreshed from the rate-limit headers of every API response, and passes them
# through as .rate_limits. That beats polling the usage endpoint outright:
# fresher (per response, not per 180s), free, and impossible to rate-limit.
#
# It has exactly one gap. The state starts empty, so a session that has not made
# a request yet sends no .rate_limits at all. (Expired windows are dropped by
# Claude Code as well, so whatever stdin does give us is live by construction —
# only the cache below can ever be stale.)
#
# The cache covers that gap and nothing else: every render persists what stdin
# gave, and a render with nothing on stdin falls back to it. Those values are
# then by definition from an earlier session, and render_usage_window dims any
# whose window has since reset.

# Persist the stdin windows so the next session has something to start from.
# Temp + rename, because sessions render concurrently and share this one file:
# a reader must never catch it half-written.
persist_rate_limits() {
    local payload="$1" tmp="$RATE_LIMIT_CACHE.$$"
    [ -n "$payload" ] || return 0
    if printf '%s' "$payload" > "$tmp" 2>/dev/null; then
        mv -f "$tmp" "$RATE_LIMIT_CACHE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    fi
    return 0
}

# Print the rate-limit windows as JSON, merged per window.
#
# Merged, not "stdin or cache": Claude Code drops a window the moment it resets,
# so a 5h window that expires mid-session vanishes from stdin until the next API
# response brings the fresh one. Taking stdin wholesale would blank the 5h gauge
# for that gap. Merging keeps the last known value of every window, which
# render_usage_window then dims with a '~' — the honest reading, and what the
# old polling path showed too.
#
# Args: <the raw stdin blob>
get_rate_limits() {
    local live cached merged
    live=$(printf '%s' "$1" | jq -c '.rate_limits // empty' 2>/dev/null)
    cached=$(cat "$RATE_LIMIT_CACHE" 2>/dev/null)

    if [ -z "$live" ]; then
        printf '%s' "$cached"
        return 0
    fi

    # `*` is jq's recursive merge, right side winning: stdin's windows overwrite
    # the cached ones, and a window only the cache still has survives untouched.
    merged=$(jq -cn --argjson cached "${cached:-null}" --argjson live "$live" \
        '($cached // {}) * $live' 2>/dev/null)
    [ -n "$merged" ] || merged="$live"   # unreadable cache: stdin alone still renders

    persist_rate_limits "$merged"
    printf '%s' "$merged"
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
# resets_at is unix epoch seconds, so this is a plain numeric compare — the old
# ISO-string form needed a lexicographic trick to stay off GNU-only `date -d`.
# Only cached values reach the stale branch: stdin never carries an expired window.
render_usage_window() {
    local label="$1" pct="$2" reset="$3" disp
    [ "${pct%.*}" -ge 0 ] 2>/dev/null || return 1
    disp=$(printf "%.0f" "$pct" 2>/dev/null || echo "$pct")
    if [ -n "$reset" ] && [ "${reset%.*}" -le "$NOW_EPOCH" ] 2>/dev/null; then
        printf '%s%s ~%s%%%s' "$C_DIM" "$label" "$disp" "$C_RESET"
    else
        set_color_by_pct "$pct" 50 80
        printf '%s %s%s%%%s' "$label" "$_color" "$disp" "$C_RESET"
    fi
}

# ── Diagnostics (DX): `statusline.sh --doctor` ──
# There is far less to go wrong now that nothing is fetched: this reports where
# the numbers come from and what the fallback cache holds. It cannot show the
# live values — those ride in on stdin, which a bare --doctor run has none of.
run_doctor() {
    local now age r5 r7 legacy found
    now=$(date +%s)
    echo "byj-cc-statusline doctor"
    echo "platform : $(uname)  bash ${BASH_VERSION}"
    echo "now      : $now  ($(date -u +%Y-%m-%dT%H:%M:%S) UTC)"
    echo

    echo "[source] Claude Code stdin, .rate_limits  — no network, no token, no lock"
    echo "  Live 5h/7d values ride in on the rate-limit headers of this session's own"
    echo "  API responses. A session that has not sent a message yet carries none, and"
    echo "  Claude Code drops a window once it resets; both fall back to the cache"
    echo "  below, which renders dimmed with a '~' once its window has passed."
    echo

    echo "[cache] $RATE_LIMIT_CACHE"
    if age=$(get_file_age "$RATE_LIMIT_CACHE"); then
        echo "  written : ${age}s ago"
        jq -r 'def pct: if type == "number" then (round | tostring) else "-" end;
               "  5h      : \(.five_hour.used_percentage  | pct)%  resets \(.five_hour.resets_at  // "-")",
               "  7d      : \(.seven_day.used_percentage | pct)%  resets \(.seven_day.resets_at // "-")"' \
            "$RATE_LIMIT_CACHE" 2>/dev/null || echo "  (unreadable — it will be rewritten by the next render that has stdin windows)"
        r5=$(jq -r '.five_hour.resets_at  // ""' "$RATE_LIMIT_CACHE" 2>/dev/null)
        r7=$(jq -r '.seven_day.resets_at // ""' "$RATE_LIMIT_CACHE" 2>/dev/null)
        report_window "5h" "$r5" "$now"
        report_window "7d" "$r7" "$now"
    else
        echo "  (none yet — normal until a session renders while it has rate limits)"
    fi
    echo

    echo "[legacy] artifacts of the old OAuth-polling path"
    found=""
    for legacy in usage.json usage.state usage.lock usage.lock.d; do
        if [ -e "$USAGE_CACHE_DIR/$legacy" ]; then
            echo "  present : $legacy  (removed on the next render)"
            found=1
        fi
    done
    [ -z "$found" ] && echo "  none — cleaned up"
}

# Doctor helper: is a cached window still in the future?
report_window() {
    local label="$1" reset="$2" now="$3"
    [ -n "$reset" ] || return 0
    if [ "${reset%.*}" -le "$now" ] 2>/dev/null; then
        echo "  $label win  : EXPIRED $(( now - ${reset%.*} ))s ago (shown dim ~)"
    else
        echo "  $label win  : valid for $(( ${reset%.*} - now ))s more"
    fi
}

# Sourcing with BYJ_STATUSLINE_LIB=1 loads the functions only — no renderer, no
# writes to the cache. Lets a test script exercise the helpers in isolation.
[ -n "${BYJ_STATUSLINE_LIB:-}" ] && return 0 2>/dev/null

# ── Main logic ──

# Pre-create the cache dir (avoid repeated mkdir calls)
mkdir -p "$USAGE_CACHE_DIR"

# Legacy cleanup: the old OAuth-polling path left a response cache, a cooldown
# file and a lock directory behind. Guarded by a test so the steady state, where
# none of them exist, forks nothing.
for legacy in usage.json usage.state usage.lock usage.lock.d; do
    [ -e "$USAGE_CACHE_DIR/$legacy" ] && rm -rf "$USAGE_CACHE_DIR/$legacy"
done

# Diagnostic mode: `statusline.sh --doctor` (no stdin needed)
if [ "${1:-}" = "--doctor" ]; then
    run_doctor
    exit 0
fi

# Read JSON data from stdin
input=$(cat)

# Extract the needed fields from JSON in one pass
# Fields are joined on US (0x1f), not a tab: a tab is IFS *whitespace*, so bash
# collapses runs of it and one empty field (an absent .session_id) would shift
# every field after it. A non-whitespace IFS keeps empty fields in position.
IFS=$'\037' read -r model cwd session_id context_window_size input_tokens cache_creation cache_read <<< \
    "$(echo "$input" | jq -r '[
        .model.display_name,
        .workspace.current_dir,
        (.session_id // ""),
        (.context_window.context_window_size // 0),
        (.context_window.current_usage.input_tokens // 0),
        (.context_window.current_usage.cache_creation_input_tokens // 0),
        (.context_window.current_usage.cache_read_input_tokens // 0)
    ] | map(tostring) | join("\u001f")')"

dir=$(basename "$cwd")
cd "$cwd" 2>/dev/null || cd ~

# Collect output segments into two lines
# line1: context (model, location, git)
# line2: metrics (fuel, API usage)
line1_segments=()
line2_segments=()
line1_segments+=("🤖 ${C_CYAN}${model}${C_RESET}")

# ── Location / session identity ──
# A derived session name is "<dir>-XX", so printing it next to 📁 would just
# repeat the directory. Fold it into the 📁 segment instead, and only break it
# out under 🏷️ once /rename has made the name something 📁 no longer tells you.
session_name=$(get_session_name "$session_id")
name_covers_dir=""
if [ -n "$session_name" ]; then
    case "$session_name" in
        "$dir"|"$dir"-*) name_covers_dir=1 ;;
    esac
fi

if [ -n "$name_covers_dir" ]; then
    line1_segments+=("📁 ${C_BLUE}${session_name}${C_RESET}")
else
    line1_segments+=("📁 ${C_BLUE}${dir}${C_RESET}")
    [ -n "$session_name" ] && line1_segments+=("🏷️ ${C_BLUE}${session_name}${C_RESET}")
fi

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
usage_json=$(get_rate_limits "$input")
if [ -n "$usage_json" ]; then
    NOW_EPOCH=$(date +%s)

    IFS=$'\037' read -r session_pct session_reset weekly_pct weekly_reset <<< \
        "$(printf '%s' "$usage_json" | jq -r '[
            (.five_hour.used_percentage  // -1),
            (.five_hour.resets_at        // ""),
            (.seven_day.used_percentage  // -1),
            (.seven_day.resets_at        // "")
        ] | map(tostring) | join("\u001f")' 2>/dev/null)"

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
