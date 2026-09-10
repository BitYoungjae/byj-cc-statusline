# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a custom statusline for Claude Code that displays:
- Model name
- Current directory, or the session's cross-session messaging name when that name covers the directory
- Git branch and status (clean, modified, staged, untracked)
- Token usage "fuel gauge" showing remaining context before autocompact
- API usage gauge showing 5-hour session and 7-day weekly utilization

Example output (two lines):
```
🤖 Sonnet 4.5 | 📁 my-project-a4 | 🌿 main ✓
⛽ 36% (57K) | 📊 5h 20% · 7d 45%
```

## Architecture

The project consists of two main components:

1. **bin/statusline.sh** - The core statusline script that:
   - Receives JSON input from Claude Code via stdin
   - Extracts model name, workspace directory, session id, and transcript path using `jq`
   - Resolves the session's cross-session messaging name from `~/.claude/sessions/`
   - Checks git status using `git` commands with `gc.autodetach=false` config
   - Parses the transcript JSONL file to calculate token usage
   - Reads `~/.claude/settings.json` to check autocompact settings
   - Queries Anthropic Usage API for 5-hour/7-day utilization (with caching)
   - Outputs formatted status with ANSI color codes

2. **install-statusline.sh** - Installation script that:
   - Validates dependencies (jq)
   - Creates backups in `~/.local/share/byj-cc-statusline/backups/`
   - Copies statusline.sh to `~/.claude/`
   - Updates `~/.claude/settings.json` with statusLine configuration

## Key Technical Details

### Session Identity (cross-session messaging name)
Claude Code lets sessions message each other, addressing a peer by **name** (the
name `ListAgents` prints, e.g. `my-project-a4`). Two different names exist, and only
one of them is addressable:

| Source | Example | Addressable? |
|---|---|---|
| stdin `session_name` | `Fix the fuel gauge` | No — this is the conversation title (AI-generated or custom) |
| `~/.claude/sessions/<pid>.json` → `.name` | `my-project-a4` | Yes — this is what a peer puts in `SendMessage` |

So the displayed name is read from the **session registry**, not from stdin:
- One JSON file per live session, named by pid, matched on its `.sessionId` field against stdin `.session_id` (the filename is a pid, not a session id).
- `grep -l` narrows to the matching file before any parsing, then **one `jq` per matched file** — never one slurped call over all of them. A single file left truncated by a session killed mid-write makes `jq` reject its entire input, which would hide the name for as long as that file sits in the directory. Read separately, a bad file costs only itself.
- A resumed session can leave the previous pid's file behind, so the entry with the highest `updatedAt` wins.
- `/rename` rewrites `.name`; the registry is read on every render, so the display follows a rename with no restart.
- Costs ~4ms per render. When no entry is found (registry missing, id absent), the name is simply omitted — the line never breaks.

**Display rule** — a derived name is `<dir>-XX`, so printing it beside 📁 would just repeat the directory:
- name covers the directory (`$dir` or `$dir-*`) → it replaces the 📁 value: `📁 my-project-a4`
- name is unrelated (after `/rename`) → 📁 keeps the directory and the name gets its own 🏷️ segment: `📁 my-project | 🏷️ fuel-gauge-fix`

### Field Splitting (a footgun to preserve)
Multi-field `jq` reads join on **US (`\u001f`) and split with `IFS=$'\037'`** — never `@tsv`.
A tab is IFS *whitespace*, so bash collapses runs of it: one empty field (an absent
`.session_id`, a missing `resets_at`) silently shifts every field after it, which
corrupted the fuel gauge and mixed the 5h/7d values into the wrong slots. A
non-whitespace separator keeps empty fields in position.

### Token Usage Calculation
- Context window size: read from stdin `context_window.context_window_size`
- Autocompact buffer: 33K tokens (fixed, all models)
- Safe limit: context_window_size - 33K
- Fuel percentage = remaining tokens / safe limit × 100
- Reads autocompact setting from `~/.claude.json` (defaults to true)
- When autocompact disabled: buffer = 3K tokens
- Combines: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`

### Git Status Detection
Uses `git -c gc.autodetach=false` to prevent git garbage collection during status checks:
- Red dot (🔴): Modified files (`git diff --quiet`)
- Green dot (🟢): Staged files (`git diff --cached --quiet`)
- Yellow dot (🟡): Untracked files (`git ls-files --others --exclude-standard`)
- Green checkmark (✓): Clean working tree

### API Usage (Anthropic Usage API)
- Endpoint: `GET https://api.anthropic.com/api/oauth/usage`
- Auth: OAuth token from macOS Keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json`
- Required header: `anthropic-beta: oauth-2025-04-20`
- Displays: 5-hour session utilization (`five_hour.utilization`) and 7-day weekly utilization (`seven_day.utilization`)
- Cache: `~/.cache/byj-cc-statusline/usage.json` (180s TTL; mtime = last successful fetch)
- Single-flight lock: `~/.cache/byj-cc-statusline/usage.lock.d` (atomic `mkdir`; only one render fetches at a time). Prevents concurrent renders from bursting the endpoint into a `429`. The holder records its PID in `usage.lock.d/pid`, so a lock leaked by a render that died mid-fetch is reclaimed by the next render via **two independent nets**: the holder PID being gone (`kill -0`) reclaims instantly, and age > 60s (`USAGE_LOCK_STALE`) reclaims regardless (backstop covering PID reuse / an unreadable pid file). A leaked lock can therefore never freeze the gauge. The orphan steal is made atomic with a rename (`mv` aside) so that, of N renders that simultaneously find a lock reclaimable, only one wins. Release only removes the lock if the caller still owns it (pid matches).
- Cooldown/diagnostic state: `~/.cache/byj-cc-statusline/usage.state` (written only after an error). Backoff is exponential with jitter and **capped at 300s** — even a `429` carrying `Retry-After: 3600` is capped, so a transient rate-limit can never freeze the display for hours/days. Reset to zero on the next `200`.
- Stale cache is always served when a refresh is skipped (lock held / in cooldown) or fails, so the line always shows something.
- Staleness display: each window is dimmed with a `~` prefix (e.g. `~20%`) once `now` (UTC) passes that window's `resets_at`, via a portable lexicographic string compare (no GNU-only `date -d`).

### Color Coding
- Fuel gauge colors: Green (≥70%), Yellow (30-70%), Red (<30%)
- Usage gauge colors: Green (<50%), Yellow (50-80%), Red (≥80%)
- Warning icon (⚠️) appears when fuel < 30%
- Stale usage windows are dimmed (`\033[2m`) with a `~` prefix instead of the normal green/yellow/red
- All colors use ANSI escape codes (e.g., `\033[32m` for green)

## Testing

To test the statusline locally without installing:

```bash
# Create sample JSON input (adjust paths to match your system)
cat > /tmp/test-input.json << 'EOF'
{
  "model": {"display_name": "Sonnet 4.5"},
  "workspace": {"current_dir": "/path/to/test"},
  "transcript_path": "/path/to/transcript.jsonl"
}
EOF

# Test the script
cat /tmp/test-input.json | bash bin/statusline.sh
```

### Diagnostics

```bash
# One-command health check for the usage gauge: cache age + window expiry,
# lock state, cooldown / last error, token presence, and a read-only live API fetch.
# This is the first thing to run if 5h/7d stops updating.
bash bin/statusline.sh --doctor
```

## Installation

```bash
# Standard installation
bash install-statusline.sh

# Verify installation
ls -la ~/.claude/statusline.sh
cat ~/.claude/settings.json | jq '.statusLine'
```

## Dependencies

- **jq** - Required for JSON parsing
- **curl** - Required for API usage fetching
- **git** - Optional, for git status display
- **bash** - Shell interpreter

## File Locations

- Script: `~/.claude/statusline.sh`
- Settings: `~/.claude/settings.json`
- Backups: `~/.local/share/byj-cc-statusline/backups/YYYYMMDD_HHMMSS/`
- Session registry (read-only, owned by Claude Code): `~/.claude/sessions/<pid>.json`
- Usage cache: `~/.cache/byj-cc-statusline/usage.json`
- Single-flight lock: `~/.cache/byj-cc-statusline/usage.lock.d/` (directory)
- Cooldown/diagnostic state: `~/.cache/byj-cc-statusline/usage.state`
