// How the segments fit the width on hand: one line when everything fits,
// otherwise two, each line as rich as its own room allows; and under them,
// while anything is going on, the activity line.

import { width } from './format'
import { build } from './segments'
import { SEPARATOR_WIDTH, type Detail, type Frame, type Live, type Part, type Row, type Seg, type Settings } from './style'

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

/** What the drawing makes of one run of parts: plain text, one button, or one live element. */
export type Chunk = {
  parts: Part[]
  copy?: { id: string; text: string }
  press?: 'compact'
  live?: Live
}

/**
 * A segment's parts as they draw: parts that share a copy target become one
 * chunk, a part that is a press or a live element its own, the rest one each.
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
        ...(part.live === undefined ? {} : { live: part.live }),
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

/** The segments at each level of detail, each level built once however many lines ask for it. */
type Levels = (detail: Detail) => Seg[]

function levelsOf(frame: Frame, settings: Settings): Levels {
  const built = new Map<Detail, Seg[]>()

  return detail => {
    let segs = built.get(detail)

    if (segs === undefined) {
      segs = build(frame, settings, detail)
      built.set(detail, segs)
    }

    return segs
  }
}

/** One line's segments at the richest detail that fits; failing that, the bare minimum, shed by priority. */
function bestRow(levels: Levels, columns: number, rows: readonly Row[]): Seg[] {
  const of = (detail: Detail) => levels(detail).filter(seg => rows.includes(seg.row))

  for (const detail of [0, 1, 2] as const) {
    const line = of(detail)

    if (lineWidth(line) <= columns) return line
  }

  return shed(of(2), columns)
}

/**
 * The band's lines for `columns` cells.
 *
 * One line when everything fits at full detail (unless two-line is asked for).
 * Otherwise two, context then metrics, and each takes the richest detail it
 * has room for on its own: a long directory name squeezing the first line
 * should not cost the second its bars. The activity line, when there is one,
 * goes under them and fits itself the same way.
 */
export function arrange(frame: Frame, settings: Settings, columns: number): Seg[][] {
  const levels = levelsOf(frame, settings)
  const activity = bestRow(levels, columns, ['activity'])
  const tail = activity.length > 0 ? [activity] : []

  if (settings.layout === 'auto') {
    const all = levels(0).filter(seg => seg.row !== 'activity')

    if (lineWidth(all) <= columns) return [all, ...tail]
  }

  return [
    ...(['context', 'metrics'] as const)
      .map(row => bestRow(levels, columns, [row]))
      .filter(line => line.length > 0),
    ...tail,
  ]
}
