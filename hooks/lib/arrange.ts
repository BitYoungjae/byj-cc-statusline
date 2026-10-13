// How the segments fit the width on hand: one line when everything fits,
// otherwise two, each line as rich as its own room allows.

import { width } from './format'
import { build } from './segments'
import { SEPARATOR_WIDTH, type Frame, type Part, type Seg, type Settings } from './style'

export function partsWidth(parts: readonly Part[]): number {
  let cells = 0

  for (const part of parts) cells += width(part.text)

  return cells
}

export function lineWidth(line: readonly Seg[]): number {
  let cells = 0

  for (const seg of line) cells += partsWidth(seg.parts)

  return cells + SEPARATOR_WIDTH * Math.max(0, line.length - 1)
}

/** A line as the text it draws, segments joined by ` · `. */
export function plain(line: readonly Seg[]): string {
  return line.map(seg => seg.parts.map(part => part.text).join('')).join(' · ')
}

/** What the drawing makes of one run of parts: plain text, or one button. */
export type Chunk = {
  parts: Part[]
  copy?: { id: string; text: string }
  press?: 'compact'
}

/**
 * A segment's parts as they draw: parts that share a copy target become one
 * chunk, a part that is a press its own, the rest one each.
 */
export function chunkParts(parts: readonly Part[]): Chunk[] {
  const out: Chunk[] = []

  for (const part of parts) {
    if (part.text === '') continue

    const last = out[out.length - 1]

    if (part.copy !== undefined && last?.copy?.id === part.copy.id) {
      last.parts.push(part)
    } else {
      out.push({
        parts: [part],
        ...(part.copy === undefined ? {} : { copy: part.copy }),
        ...(part.press === undefined ? {} : { press: part.press }),
      })
    }
  }

  return out
}

/** Drops segments, the least wanted first, until the line fits or only the essentials are left. */
function shed(line: readonly Seg[], columns: number): Seg[] {
  const kept = [...line]

  while (lineWidth(kept) > columns) {
    let worst = -1

    for (const [index, seg] of kept.entries()) {
      if (seg.priority > 0 && seg.priority > (kept[worst]?.priority ?? 0)) worst = index
    }

    if (worst === -1) break
    kept.splice(worst, 1)
  }

  return kept
}

/** One line's segments at the richest detail that fits; failing that, the bare minimum, shed by priority. */
function bestRow(frame: Frame, settings: Settings, columns: number, row: Seg['row']): Seg[] {
  for (const detail of [0, 1, 2] as const) {
    const line = build(frame, settings, detail).filter(seg => seg.row === row)

    if (lineWidth(line) <= columns) return line
  }

  return shed(
    build(frame, settings, 2).filter(seg => seg.row === row),
    columns,
  )
}

/**
 * The band's lines for `columns` cells.
 *
 * One line when everything fits at full detail (unless two-line is asked for).
 * Otherwise two, context then metrics, and each takes the richest detail it
 * has room for on its own: a long directory name squeezing the first line
 * should not cost the second its bars.
 */
export function arrange(frame: Frame, settings: Settings, columns: number): Seg[][] {
  if (settings.layout === 'auto') {
    const all = build(frame, settings, 0)

    if (lineWidth(all) <= columns) return [all]
  }

  return (['context', 'metrics'] as const)
    .map(row => bestRow(frame, settings, columns, row))
    .filter(line => line.length > 0)
}
