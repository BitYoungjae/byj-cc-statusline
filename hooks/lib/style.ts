// The band's vocabulary: what a segment is made of, and the two looks it can
// wear.
//
// The modern look is calm by default. Labels and units sit in the theme's
// secondary text, values in the plain text colour, gauges in one quiet accent.
// Colour is spent where a look is needed: a gauge running low, a window
// running hot, a conflict. The emoji look is the original statusline's.

import type { GitInfo, Identity, Usage } from '../../types'
import type { Level } from './format'

export type Part = {
  text: string
  /** A theme key (`warning`, `inactive`...), so the band follows the person's theme. */
  color?: string
  /** A theme key for the background: a chip. Kept for alarms. */
  bg?: string
  dim?: boolean
  bold?: boolean
  underline?: boolean
  /** Draws the part as a button; the drawing hook says what pressing it does. */
  press?: 'compact'
  /**
   * A click copies `text`. Consecutive parts with the same `id` are one button,
   * so a glyph and the name beside it are one target.
   */
  copy?: { id: string; text: string }
}

/** The details behind a segment, shown while the pointer rests on it. */
export type Card = {
  title: string
  rows: Part[][]
}

export type Seg = {
  id: string
  /** Which line it belongs to when the band takes two. */
  row: 'context' | 'metrics'
  /** 0 is never dropped; a larger number goes first when a line cannot fit. */
  priority: number
  parts: Part[]
  card?: Card
}

export type Settings = {
  layout: 'auto' | 'two-line'
  icons: 'symbols' | 'emoji'
  showCost: boolean
}

export type Frame = {
  identity: Identity
  git: GitInfo | null
  usage: Usage
  /** Wall clock in ms. */
  now: number
  /** True while a turn runs: nothing is offered to press then. */
  isWorking: boolean
}

/** How much a segment says: 0 everything, 1 trimmed, 2 the bare minimum. */
export type Detail = 0 | 1 | 2

export type Glyphs = {
  /** The calm palette, the effort meter and the pace marks; off, the original's traffic lights. */
  isModern: boolean
  separator: string
  model: string
  effort: string
  place: string
  tag: string
  branch: string
  fuel: string
  fuelLow: string
  usage: string
}

// Every glyph of the modern look is in the fonts terminals ship with (box
// drawing, block elements, Latin-1), so none falls back to a font of another
// width.
export const GLYPHS: Record<Settings['icons'], Glyphs> = {
  symbols: {
    isModern: true,
    separator: ' · ',
    model: '',
    effort: '',
    place: '',
    tag: '@',
    branch: '',
    fuel: 'fuel ',
    fuelLow: 'fuel ',
    usage: '',
  },
  emoji: {
    isModern: false,
    separator: ' | ',
    model: '🤖 ',
    effort: '🧠 ',
    place: '📁 ',
    tag: '🏷️ ',
    branch: '🌿 ',
    fuel: '⛽ ',
    fuelLow: '⚠️ ',
    usage: '📊 ',
  },
}

/** Between two segments; between the two groups of a one-line band, at least as wide. */
export const SEPARATOR_WIDTH = 3

export function separatorPart(settings: Settings): Part {
  return { text: GLYPHS[settings.icons].separator, color: 'subtle' }
}

/** A value's colour by its level: plain text while calm in the modern look, green in the original. */
export function levelColor(level: Level, glyphs: Glyphs = GLYPHS.symbols): string | undefined {
  if (level === 'good') return glyphs.isModern ? undefined : 'success'

  return level === 'warn' ? 'warning' : 'error'
}

/** A gauge's fill: the one accent of the modern look while calm. */
export function fillColor(level: Level, glyphs: Glyphs): string {
  if (level === 'good') return glyphs.isModern ? 'suggestion' : 'success'

  return level === 'warn' ? 'warning' : 'error'
}

/** Labels, units and asides: the theme's secondary text, readable but out of the way. */
export function quiet(text: string): Part {
  return { text, color: 'inactive' }
}

/** A gauge's empty track and the separators: the faintest grey the theme has. */
export function faint(text: string): Part {
  return { text, color: 'subtle' }
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
