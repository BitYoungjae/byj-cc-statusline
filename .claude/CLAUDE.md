# CLAUDE.md

A Claude Code mod: a status band drawn by a `ui.render` hook on `AbovePrompt`.
The repository root is the plugin and its own marketplace (`.claude-plugin/`).

## Layout

- `hooks/register.tsx`: the hooks and everything that calls `$`. The validator only
  accepts `$` passed to top-level function declarations, so the helpers live at module
  level, with module-level state.
- `hooks/lib/`: no `$` anywhere.
  - `format.ts` numbers and text: fuel, pace, turns left, countdowns, tracks, widths
  - `style.ts` the `Part`/`Seg`/`Card` types, the two looks (glyphs), the palette
  - `segments.ts` what each part of the band says, per level of detail
  - `cards.ts` the hover cards
  - `arrange.ts` fitting the segments to a width: one line or two, trim, shed
  - `view.ts` the element tree; takes the element constructors and press closures as arguments
  - `git.ts`, `session-name.ts` parsing
- `types/index.d.ts`: the `$.state` contract.

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
  Latin-1). No `↻ ⎇ ⧉ ⚠`; they fall back to other fonts at other widths.
- Hooks that sit in the way of something (`session.compact`, `prompt.submit`,
  `tool.call`) carry `.catch(($, e, next) => next(e))`: a status must never block.

## Checks

```sh
claude plugin validate .
claude plugin test .
tsc -p .    # needs .claude-plugin/types/, which Claude Code writes when it loads the mod
```
