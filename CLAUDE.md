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
   - Reads 5h/7d rate limits from stdin `.rate_limits` (cached only to bridge session start)
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

### API Usage (5h / 7d rate limits)
Read from **stdin**, not fetched. Claude Code keeps the windows in memory, refreshed
from the rate-limit headers of every API response, and passes them through as
`.rate_limits`:

```json
"rate_limits": {
  "five_hour": { "used_percentage": 7.0, "resets_at": 1789038600 },
  "seven_day": { "used_percentage": 29.0, "resets_at": 1789444800 }
}
```

`used_percentage` is 0–100 and `resets_at` is **unix epoch seconds** (the old OAuth
endpoint returned an ISO string, which is why the staleness compare used to be
lexicographic).

This replaced a poll of `GET /api/oauth/usage` and deleted the OAuth token lookup,
`curl` call, 180s TTL, atomic-`mkdir` single-flight lock and capped exponential
backoff along with it — a 204-line block plus its config and diagnostics, replaced by
about 45 lines. The whole class of bug that froze the gauge twice (commits 530388d,
8a839b6) went with it: there is now no network call in the statusline at all, so
there is nothing to rate-limit, lock, or back off from. The script is 406 lines,
down from 504, while also gaining the session-name lookup.

**Two properties of the stdin data drive the rest of the design:**
1. *It starts empty.* The state is in-memory and populated from response headers, so
   a session that has not made a request yet sends no `rate_limits` at all.
2. *Expired windows are dropped.* Claude Code filters to `resets_at > now`, so any
   window stdin does carry is live by construction — only cached values go stale.

**Cache** (`~/.cache/byj-cc-statusline/rate-limits.json`) exists solely to cover those
two gaps:
- Every render persists what it rendered, so the next session starts with something.
- Windows are **merged per window**, not overwritten. A 5h window that resets mid-session
  disappears from stdin until the next API response; taking stdin wholesale would blank
  the 5h gauge for that gap, so the cached value survives and renders dimmed instead.
- Written temp-then-`mv` (atomic rename). Sessions render concurrently and share this
  one file, so a reader must never catch it half-written.
- No TTL, no lock, no cooldown — a write is unconditional and cannot fail in a way that
  blocks a render.
- Staleness display: a window is dimmed with a `~` prefix (e.g. `~20%`) once `resets_at`
  has passed — a plain numeric compare against `date +%s`.

**Version requirement:** `.rate_limits` on stdin (verified on Claude Code 2.1.267). On a
build too old to send it, the gauge shows the cached values dimmed, or nothing at all on
a fresh install.

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
# Health check for the usage gauge: where the numbers come from, the fallback
# cache (values + window expiry), and any leftover OAuth-era artifacts. It cannot
# show live values — those ride in on stdin, which a bare --doctor run has none of.
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
- **git** - Optional, for git status display
- **bash** - Shell interpreter

## File Locations

- Script: `~/.claude/statusline.sh`
- Settings: `~/.claude/settings.json`
- Backups: `~/.local/share/byj-cc-statusline/backups/YYYYMMDD_HHMMSS/`
- Session registry (read-only, owned by Claude Code): `~/.claude/sessions/<pid>.json`
- Rate-limit cache: `~/.cache/byj-cc-statusline/rate-limits.json`

Removed with the OAuth-polling path (the script deletes these on sight): `usage.json`,
`usage.state`, `usage.lock`, `usage.lock.d/`.
