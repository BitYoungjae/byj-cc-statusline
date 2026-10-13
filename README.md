# byj-cc-statusline

A status band for [Claude Code](https://claude.com/claude-code) that sits right above the prompt and looks like part of Claude Code itself.

![A live session: tools, a subagent and the tally move on the activity line while Claude works; afterwards the cache starts counting down](docs/session.gif)

It is a Claude Code mod, so instead of being re-run with a JSON blob it gets told when something changes. It updates while a turn is still running, follows every tool and subagent as it starts and ends, redraws for whatever width you have, and shows more when you point at it. The gauges use the same colours Claude Code's `/usage` draws its bars in, and they follow your theme.

## Install

```
/plugin install byj-statusline --marketplace BitYoungjae/byj-cc-statusline
```

Type that at the Claude Code prompt, answer `y` to add the marketplace, then pick a scope. Mods need Claude Code 2.1.287 or newer.

Coming from the old bash version? Delete the `statusLine` entry in `~/.claude/settings.json`, or you will see both.

## Reading it

```
 Opus 5.5  ▁▂▄▆█ xhigh   pantry-k2   feat/receipt-scan +2 ~3 ?1 ↑1    fuel ██████▋     66% 104K left   5h ███▊   │  47% 1h54m   7d ██▊ ┃     36% 4d2h    cache 4:12
 ▝ Edit receipt.ts   ■ Explore find the parsers 0:34   tasks ███▌   3/5 Writing the tests   Read ×4  Grep ×2
```

**Model and effort.** The model sits on the same background your prompts have in the transcript. The bars light up from `low` (one) to `max` (all five, in the violet Claude Code uses for its highest effort). It shows the level the last request was actually sent with, and follows `/effort` without waiting for the next request.

**Session name.** Other sessions message this one by the name `ListAgents` prints. A name Claude Code picked is just the folder plus a short suffix, so it takes the folder's place. After `/rename` the folder comes back and the name sits next to it as `@name`.

**Git.** `+` staged, `~` modified, `?` untracked, `!` conflicted, `↑` `↓` ahead and behind. It refreshes after any tool that can touch files.

**fuel.** Room left before auto-compact, measured against the point where Claude Code says it will compact. It moves during a turn, not only at the end. Yellow under 70%, red under 30%. In the red the number lights up and a `/compact` button appears; clicking it types the command into an empty prompt and leaves the Enter to you.

**5h and 7d.** Plan usage and the time until each window resets. The tick on the gauge is where you would be if you used the window evenly. Fill past the tick means you are going faster than that, and when that pace would hit the limit before the reset, the tick turns amber. A window that has reset since the last reply keeps its old value, dimmed, like `~64%`, until the next reading comes in.

**cache.** Between turns: how long until the prompt cache lapses. Each request refreshes it; once it lapses, the next message pays to write the whole context to the cache again. It counts down by the second in its last ten minutes and reads `cold` when it has run out (in amber when there is a lot to rewrite). Whether entries live five minutes or an hour is read from your session's own transcript and remembered.

All the figures keep their width as they change, so the band holds still. While everything is fine the colours stay quiet. Yellow and red only show up when something needs a look.

## While Claude works

A second line comes in under the band while a turn runs, and goes again when it ends:

- **the tool running now**, with a small spinner, and what it works on: `Edit receipt.ts`, `Bash npm test`, `Grep parseTotal`
- **subagents**, each with its type, its task and a clock that ticks while it runs; a finished one stays for half a minute with `✓` (or `!` when it failed)
- **tasks**, when Claude keeps a task list: how many are done and the one under way
- **the turn's tally**, the tools it has run so far, most used first, with `!` where one failed

Between turns the line stays only for something that goes on without you: a subagent still running in the background, or a task still marked in progress.

The clocks and the spinner tick on the terminal's own frame clock, so the band itself never redraws for a second hand.

## Pointing at things

![Resting the pointer on a part opens a card with the details behind it](docs/details.gif)

Rest the pointer on a part and it lights up, and a card opens above the band:

- **model**: the full id, the effort level, and what the last turn came to (time, tools, edits, cost)
- **session name**: what the name is for, and the full path
- **branch**: the counts spelled out, and what is left to push or pull
- **fuel**: what fills the context, as one bar in `/context`'s colours with the compaction reserve hatched at the end; how full it was over the last turns; how much the last turn added, and about how many more turns like it fit
- **5h / 7d**: a large gauge with the pace mark, how much of the window is gone, where you will end up at this pace or when you will run out, and when it resets
- **cache**: how long entries live, how much of the last request came from the cache, and how much a cold message would rewrite
- **the activity line**: the turn's tools in full, each subagent with its task, time, tool count and what it is doing now, and the whole task list

Clicking the model, the session name, the folder or the branch copies it. If clicks don't reach the band in your terminal, `ctrl+x tab` focuses it and Enter presses the focused item.

## Narrow windows

![The band going from one line to two, then trimming itself as the window gets narrower](docs/widths.gif)

Everything goes on one line when it fits, otherwise on two. Each line then trims itself on its own: first the reset times go and the gauges get shorter, then the gauges and the effort meter go. If that is still not enough, whole parts drop out in this order: cost, cache, 7d, the `@name` tag, 5h, git. The model, the session name and fuel always stay. The activity line does the same on its own: finished subagents go first, then the tally, then tasks; the tool running now and the subagents still running stay.

## Options

In `/config`, under byj-statusline:

| Option | Default | |
|---|---|---|
| `layout` | `auto` | `two-line` keeps the two lines apart even when one would fit |
| `icons` | `symbols` | `emoji` brings back the old statusline's look |
| `details` | on | the hover cards |
| `activity` | on | the line of tools, subagents and tasks while Claude works |
| `cache` | on | the prompt cache countdown between turns |
| `showCost` | off | adds the session's cost |
| `alerts` | on | a toast when fuel drops under 30%, when a window passes 90%, or when a window past half is on pace to run out before it resets |

Changing an option reloads the band without losing what it has measured.

## What it reads

The numbers come from Claude Code itself: usage and rate limits from the session, the effort from each request, the compaction point from the same breakdown `/context` uses, and the tools, subagents and tasks from the events Claude Code raises as they happen. Besides that it reads `~/.claude/sessions/*.json` for the session name and the effort from your settings, runs `git status`, and once a session reads the last 256 KB of its own transcript with `tail` to learn the prompt cache's TTL. The last rate-limit reading and the TTL are kept in the plugin's storage so a new session has them before its first reply. It makes no network calls.

## Hacking on it

```sh
git clone https://github.com/BitYoungjae/byj-cc-statusline
claude --plugin-dir ./byj-cc-statusline    # load it for one session; edits reload live
claude plugin test ./byj-cc-statusline     # unit and UI tests
claude plugin validate ./byj-cc-statusline
```

`hooks/register.tsx` collects the numbers. How they look is decided in `hooks/lib/`, which never talks to the engine, so most of it is tested as plain functions. `hooks/live/` holds the two small modules that tick on the terminal: the clocks and the spinner.

## License

MIT
