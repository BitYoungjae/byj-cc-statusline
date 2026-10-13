# CLAUDE.md

A Claude Code mod: a status band drawn by a `ui.render` hook on `AbovePrompt`.
The repository root is the plugin and its own marketplace (`.claude-plugin/`).

## Layout

- `hooks/register.tsx`: the hooks and everything that calls `$`. The validator only
  accepts `$` passed to top-level function declarations, so the helpers live at module
  level, with module-level state. It also builds the `Client` elements: their `module`
  paths must be string literals in the file that draws them.
- `hooks/live/`: surface modules (`ClientModule`) that tick on the drawing thread, so the
  band never redraws for them: `clock.ts` (cache countdown, subagent clocks),
  `spinner.ts`. Start `surface.every` once per instance; read the latest props, not the
  first call's.
- `hooks/lib/`: no `$` anywhere.
  - `format.ts` numbers and text: fuel, pace, turns left, countdowns, clocks, padding, widths
  - `gauge.ts` gauges as parts: eighth blocks on a background track, the pace mark, the
    context mix, the sparkline
  - `activity.ts` the turn, its tools, subagents and tasks, as pure reducers
  - `cache.ts` the prompt cache: TTL from the transcript or learnt, hit ratio, time left
  - `style.ts` the `Part`/`Seg`/`Card`/`Live` types, the two looks (glyphs), the palette
  - `segments.ts` what each part of the band says, per level of detail
  - `cards.ts` the hover cards
  - `arrange.ts` fitting the segments to a width: one line or two, trim, shed; the
    activity line under them
  - `view.ts` the element tree; takes the element constructors, press closures and the
    live-part factory as arguments
  - `git.ts`, `session-name.ts`, `settings.ts` parsing (effort is per model under
    `modelSettings`, with the old top-level `effortLevel` as the fallback)
- `types/index.d.ts`: the `$.state` contract.
- `tests/`: one suite per lib module, `band.test.ts` for the mounted band driven by
  engine events, `fixtures.ts` for the shared frame.

## Rules worth keeping

- Session name comes from `~/.claude/sessions/<pid>.json`, matched on `sessionId`, the
  highest `updatedAt` winning; each file is parsed on its own so a truncated one costs
  only itself. A name equal to the folder or `folder-*` replaces the folder; any other
  name shows as `@name` beside it.
- Fuel is remaining over the safe limit. The safe limit is the engine's
  `autoCompactThreshold` when the breakdown has one, else the window less 33K (3K with
  auto-compact off). Good from 70%, warn from 30%, bad below.
- Usage windows: good under 50%, warn under 80%, bad above. A reading past its
  `resetsAt` is a remembered one: dim, `~` prefix, no countdown. Windows merge per
  window and persist in `$.store` under `rate-limits`.
- The symbols look only uses glyphs every coding font has (box drawing, block elements,
  Latin-1, plus `↑ ↓ ✓ … − ■`). No `↻ ⎇ ⧉ ⚠ ▸ ●`; they fall back to other fonts at other
  widths. `tests/layout.test.ts` checks every character the band and its cards draw.
- Colours are theme keys. On the terminal the palette uses Claude Code's own extended
  keys (`rate_limit_fill`/`rate_limit_empty` for gauges, `userMessageBackground` for the
  model badge, `userMessageBackgroundHover`, `effortUltra`); other surfaces get the
  common `ThemeKey`s (`paletteOf`).
- Figures that move are padded to their widest (`pad`, `padEnd`, `figure`), so the band
  holds still as they change.
- The cache TTL is read from the transcript (`cache_creation.ephemeral_1h/5m`): the
  usage a `turn.step` hook gets has no split. `tail -c 256K` on `classic.Stop` (and a
  resume's `classic.SessionStart`), a few tries a session. Its sources rank: seen (the
  transcript, a resume's expiry flags) over learnt (a cache read after a gap past five
  minutes proves an hour) over assumed (5 minutes, or what an earlier session saw);
  a lower rank never overrides a higher one. Persisted in `$.store` under `cache-ttl`.
- State changes are computed after any `await`, never across one: hooks run
  concurrently (parallel tools, agents spawned together), and a value read before an
  `await` and written after it loses what another hook wrote meanwhile.
- The activity line shows while a turn runs; between turns only for a running (or just
  finished) subagent or a task in progress. Tool events are coalesced (50 ms) before the
  state is written.
- A reload (an edit, a changed option) restores from `$.state` (`resume`); `session.end`
  clears it (`clearSession`), so a `/clear` still starts from nothing.
- Hooks that sit in the way of something (`session.compact`, `prompt.submit`,
  `tool.call`, `agent.spawn`, `turn.start`, `classic.*`) carry
  `.catch(($, e, next) => next(e))`: a status must never block.

## Checks

```sh
claude plugin validate .
claude plugin test .
tsc -p .    # needs .claude-plugin/types/, which Claude Code writes when it loads the mod
```
