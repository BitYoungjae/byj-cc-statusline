// The band's vocabulary: what a segment is made of, the two looks it can
// wear, and the colours it paints with.
//
// The symbols look is calm by default and native to Claude Code: the gauges
// are /usage's own (its fill on its track), the model sits on the badge
// background a prompt has in the transcript, labels and units are the
// theme's secondary text. Colour is spent where a look is needed: a gauge
// running low, a window running hot, a conflict. The emoji look is the
// original statusline's.

import type { Activity, CacheState, GitInfo, Identity, Usage } from '../../types'
import type { Level } from './format'

/** A small live element the band hands to a surface module: it ticks without the band redrawing. */
export type Live =
  | {
      kind: 'clock'
      /** What the clock shows when drawn, in ms: time left (`down`) or time gone (`up`). */
      ms: number
      direction: 'up' | 'down'
      color?: string
      /** Counting down, under this many ms left the colour turns `soonColor`. */
      soonMs?: number
      soonColor?: string
      /** What a countdown shows once it runs out, and in what colour. */
      doneText?: string
      doneColor?: string
      /** Cells the clock always takes, so the line never shifts as it ticks. */
      width: number
    }
  | { kind: 'spinner'; color: string }

export type Part = {
  text: string
  /** A theme key (`warning`, `inactive`...), so the band follows the person's theme. */
  color?: string
  /** A theme key for the background: a gauge's track, a badge, an alarm. */
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
  /** Drawn by a surface module in place of `text`, which says what it shows first and how wide it is. */
  live?: Live
}

/** The details behind a segment, shown while the pointer rests on it. */
export type Card = {
  title: string
  /** Set against the right end of the title rule: the one figure that sums the card up. */
  aside?: Part
  rows: Part[][]
}

export type Row = 'context' | 'metrics' | 'activity'

export type Seg = {
  id: string
  /** Which line it belongs to. */
  row: Row
  /** 0 is never dropped; a larger number goes first when a line cannot fit. */
  priority: number
  parts: Part[]
  card?: Card
}

export type Settings = {
  layout: 'auto' | 'two-line'
  icons: 'symbols' | 'emoji'
  showCost: boolean
  /** The activity line: tools, subagents and tasks, while there are any. */
  hasActivity: boolean
  /** The prompt cache's countdown between turns. */
  hasCache: boolean
}

export type Frame = {
  identity: Identity
  git: GitInfo | null
  usage: Usage
  activity: Activity
  cache: CacheState
  /** Wall clock in ms. */
  now: number
  /** True while a turn runs: nothing is offered to press then, and the activity line shows. */
  isWorking: boolean
  /** The terminal knows Claude Code's whole theme; other surfaces the common keys alone. */
  isTerminal: boolean
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
  cache: string
  tools: string
  agents: string
  tasks: string
}

// Every glyph of the symbols look is in the fonts terminals ship with (box
// drawing, block elements, Latin-1), so none falls back to a font of another
// width.
export const GLYPHS: Record<Settings['icons'], Glyphs> = {
  symbols: {
    isModern: true,
    separator: '   ',
    model: '',
    effort: '',
    place: '',
    tag: '@',
    branch: '',
    fuel: 'fuel ',
    fuelLow: 'fuel ',
    usage: '',
    cache: 'cache ',
    tools: '',
    agents: '',
    tasks: 'tasks ',
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
    cache: '💾 ',
    tools: '🔧 ',
    agents: '🧩 ',
    tasks: '📋 ',
  },
}

/** Between two segments; between the two groups of a one-line band, at least as wide. */
export const SEPARATOR_WIDTH = 3

export type Palette = {
  /** The model's name and the lit effort bars. */
  accent: string
  /** The lit bars at `max`, as Claude Code marks its highest effort. */
  ultra: string
  /** A gauge's fill while calm. */
  fill: string
  /** A gauge's empty track, drawn as background. */
  track: string
  /** Behind the model: the badge the band starts with. */
  badge: string
  /** Behind a segment while the pointer rests on it. */
  hover: string
  /** A card's frame. */
  border: string
}

// The terminal draws every key of the person's theme. Another surface knows
// the common ones (ThemeKey), so there the gauges and the badge fall back on
// those.
const TERMINAL: Palette = {
  accent: 'claude',
  ultra: 'effortUltra',
  fill: 'rate_limit_fill',
  track: 'rate_limit_empty',
  badge: 'userMessageBackground',
  hover: 'userMessageBackgroundHover',
  border: 'promptBorder',
}

const COMMON: Palette = {
  accent: 'claude',
  ultra: 'merged',
  fill: 'suggestion',
  track: 'subtle',
  badge: 'subtle',
  hover: 'subtle',
  border: 'promptBorder',
}

export function paletteOf(isTerminal: boolean): Palette {
  return isTerminal ? TERMINAL : COMMON
}

export function separatorPart(settings: Settings): Part {
  return { text: GLYPHS[settings.icons].separator, color: 'subtle' }
}

/** A value's colour by its level: plain text while calm in the symbols look, green in the original. */
export function levelColor(level: Level, glyphs: Glyphs = GLYPHS.symbols): string | undefined {
  if (level === 'good') return glyphs.isModern ? undefined : 'success'

  return level === 'warn' ? 'warning' : 'error'
}

/** A gauge's fill: the calm fill of the symbols look, green in the original, then amber and red. */
export function fillColor(level: Level, glyphs: Glyphs, palette: Palette): string {
  if (level === 'good') return glyphs.isModern ? palette.fill : 'success'

  return level === 'warn' ? 'warning' : 'error'
}

/** Labels, units and asides: the theme's secondary text, readable but out of the way. */
export function quiet(text: string): Part {
  return { text, color: 'inactive' }
}

/** Separators, rules and unlit marks: the faintest grey the theme has. */
export function faint(text: string): Part {
  return { text, color: 'subtle' }
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
