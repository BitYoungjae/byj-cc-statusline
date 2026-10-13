// Gauges, as parts. A gauge is drawn the way /usage draws its own: the fill
// in one colour on a track of another, the track painted as background so
// the cell where the fill ends (an eighth block) joins both without a seam.
// Eight steps a cell make a ten-cell gauge read to the percent.

import type { ContextPart } from '../../types'
import type { Part } from './style'

/** A cell filled from the left by eighths: ▏ is one, █ all eight. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export type GaugeColors = {
  fill: string
  track: string
}

/** Where an even pace would have the fill by now, and whether keeping the pace runs the window out. */
export type Mark = {
  at: number
  color: string
  bold?: boolean
}

type Cell = { text: string; color?: string; bg?: string; bold?: boolean }

/** Eighths of fill in each of `cells` cells; anything over nothing shows at least a sliver. */
export function eighths(fraction: number, cells: number): number[] {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const total = clamped > 0 ? Math.max(1, Math.round(clamped * cells * 8)) : 0

  return Array.from({ length: cells }, (_, index) => Math.min(8, Math.max(0, total - index * 8)))
}

/** Neighbouring cells in one style become one part, so a gauge is a handful of nodes. */
function runs(cells: readonly Cell[]): Part[] {
  const out: Part[] = []

  for (const cell of cells) {
    const last = out[out.length - 1]

    if (last !== undefined && last.color === cell.color && last.bg === cell.bg && last.bold === cell.bold) {
      last.text += cell.text
    } else {
      out.push({
        text: cell.text,
        ...(cell.color === undefined ? {} : { color: cell.color }),
        ...(cell.bg === undefined ? {} : { bg: cell.bg }),
        ...(cell.bold === undefined ? {} : { bold: cell.bold }),
      })
    }
  }

  return out
}

/**
 * A gauge of `cells` cells. With a mark, the cell it falls in shows a tick
 * across the gauge, over the fill or over the track, whichever is there.
 */
export function gauge(fraction: number, cells: number, colors: GaugeColors, mark?: Mark): Part[] {
  if (cells <= 0) return []

  const filled = eighths(fraction, cells)
  const at = mark === undefined ? -1 : Math.min(cells - 1, Math.max(0, Math.floor(mark.at * cells)))
  const out: Cell[] = filled.map((count, index) => {
    if (index === at && mark !== undefined) {
      // A tick reads over whichever half of the cell is there more.
      return {
        text: count >= 4 ? '┃' : '│',
        color: mark.color,
        bg: count >= 4 ? colors.fill : colors.track,
        ...(mark.bold === true ? { bold: true } : {}),
      }
    }

    if (count === 8) return { text: '█', color: colors.fill }
    if (count === 0) return { text: ' ', bg: colors.track }

    return { text: EIGHTHS[count] ?? '', color: colors.fill, bg: colors.track }
  })

  return runs(out)
}

/**
 * The context's mix as one gauge: each kind in its own colour, largest
 * first, then the free room, then the compaction reserve, hatched. Every
 * kind that holds anything gets a cell, so none vanishes at a glance.
 */
export function mixGauge(
  parts: readonly ContextPart[],
  windowSize: number,
  safe: number,
  cells: number,
  colors: GaugeColors & { reserve: string },
): Part[] {
  if (parts.length === 0 || windowSize <= 0 || cells <= 0) return []

  const cell = windowSize / cells
  const reserve = Math.max(0, Math.min(cells, Math.round((windowSize - safe) / cell)))
  const room = cells - reserve
  const out: Cell[] = []

  for (const part of parts) {
    const count = Math.min(Math.max(1, Math.round(part.tokens / cell)), room - out.length)

    for (let index = 0; index < count; index += 1) out.push({ text: '█', color: part.color })
  }

  while (out.length < room) out.push({ text: ' ', bg: colors.track })
  for (let index = 0; index < reserve; index += 1) out.push({ text: '░', color: colors.reserve, bg: colors.track })

  return runs(out)
}

/**
 * A row of bars, one per value, each as tall as its share of `top`. The
 * scale is fixed, not the largest value's: a context that holds steady at
 * half full draws half-height bars, not a wall of full ones.
 */
export function sparkline(values: readonly number[], top: number): string {
  if (top <= 0) return ''

  return values
    .map(value => SPARK[Math.min(7, Math.max(0, Math.round((value / top) * 7)))] ?? '')
    .join('')
}
