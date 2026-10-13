// Pure helpers: the fuel arithmetic, gauge bars, countdowns, text width.
// Nothing here touches `$`, so each is tested on its own.

/** Tokens held back for auto-compaction: the fixed buffer, ON or OFF. */
export const BUFFER_AUTO_COMPACT = 33_000
export const BUFFER_MANUAL = 3_000

export type Level = 'good' | 'warn' | 'bad'

export type Fuel = {
  /** Share of the safe limit still free, 0 to 100. */
  percent: number
  /** Tokens still free before the buffer, never negative. */
  remaining: number
  level: Level
}

/** Where the context stops being usable: the engine's compaction point, or the window less the fixed buffer. */
export function safeLimit(
  windowSize: number,
  isAutoCompact: boolean,
  compactAt: number | null = null,
): number {
  if (isAutoCompact && compactAt !== null && compactAt > 0) return compactAt

  return windowSize - (isAutoCompact ? BUFFER_AUTO_COMPACT : BUFFER_MANUAL)
}

/**
 * How much room is left before auto-compaction would step in.
 *
 * The safe limit is the point the engine compacts at, when it has said; else
 * the window less the buffer. Fuel is what is left of it. Null until a
 * response has reported a token count.
 */
export function fuel(
  tokens: number | null,
  windowSize: number,
  isAutoCompact: boolean,
  compactAt: number | null = null,
): Fuel | null {
  if (tokens === null || tokens <= 0) return null

  const safe = safeLimit(windowSize, isAutoCompact, compactAt)
  const remaining = safe - tokens
  const percent =
    safe > 0 && remaining >= 0 ? Math.round((remaining * 100) / safe) : 0

  // Reversed gauge: more is better, so the thresholds run the other way.
  const level: Level = percent >= 70 ? 'good' : percent >= 30 ? 'warn' : 'bad'

  return { percent, remaining: Math.max(0, remaining), level }
}

/**
 * How many more turns like the recent ones fit: the room left over the
 * average growth of the last few turns that grew. Null when there is no
 * growth to go by (a fresh session, or one that only shrank).
 */
export function turnsLeft(remaining: number, history: readonly number[]): number | null {
  const growth: number[] = []

  for (let index = history.length - 1; index > 0 && growth.length < 3; index -= 1) {
    const delta = (history[index] ?? 0) - (history[index - 1] ?? 0)

    // A compaction or a /clear shrinks the context: not a turn's growth.
    if (delta > 0) growth.push(delta)
  }

  if (growth.length === 0) return null

  const average = growth.reduce((sum, delta) => sum + delta, 0) / growth.length

  return Math.floor(remaining / average)
}

export type Pace = {
  /** Share of the window already gone, 0 to 1. */
  elapsed: number
  /** Where the usage lands at the reset if it keeps the pace it has had. */
  projected: number
  /** Time until the limit at that pace, when that comes before the reset. */
  runsOutInMs: number | null
  resetsInMs: number
}

/**
 * Whether a window's usage is keeping up with its clock. A window that is
 * 40% gone with 60% used is burning ahead of an even pace; held to it, it
 * reaches 100% before the reset. Too early in a window the guess is noise,
 * so there is none for the first twentieth of it.
 */
export function pace(
  percentUsed: number,
  resetsAt: number,
  now: number,
  spanMs: number,
): Pace | null {
  const resetsInMs = resetsAt - now

  if (!Number.isFinite(resetsAt) || resetsInMs <= 0 || spanMs <= 0) return null

  const elapsed = Math.min(1, Math.max(0, 1 - resetsInMs / spanMs))

  if (elapsed < 0.05) return null

  const projected = percentUsed / elapsed
  const elapsedMs = elapsed * spanMs
  const toLimitMs =
    percentUsed > 0 ? ((100 - percentUsed) / percentUsed) * elapsedMs : Infinity

  return {
    elapsed,
    projected,
    runsOutInMs: percentUsed < 100 && toLimitMs < resetsInMs ? toLimitMs : null,
    resetsInMs,
  }
}

/** A usage window's colour: it fills up, so less is better. */
export function usageLevel(percent: number): Level {
  return percent < 50 ? 'good' : percent < 80 ? 'warn' : 'bad'
}

/** 57000 -> "57K"; under a thousand the number as it is. */
export function tokens(count: number): string {
  return count > 1000 ? `${Math.floor(count / 1000)}K` : String(count)
}

/** One decimal where it says something: 12400 -> "12.4K", 1250000 -> "1.3M", 57000 -> "57K". */
export function tokensFine(count: number): string {
  const short = (value: number, unit: string) =>
    `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))}${unit}`

  if (count >= 1_000_000) return short(count / 1_000_000, 'M')
  if (count >= 1_000) return short(count / 1_000, 'K')

  return String(count)
}

/** Fits `text` in `max` cells by cutting its middle, where names are least distinct. */
export function clip(text: string, max: number): string {
  if (width(text) <= max) return text
  if (max <= 1) return '…'

  const chars = [...text]
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head

  return `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(-tail).join('') : ''}`
}

export function dollars(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`
}

/** A gauge track of `cells` characters: `filled` heavy, the rest light. */
export function bar(
  fraction: number,
  cells: number,
): { filled: string; rest: string } {
  const clamped = Math.min(1, Math.max(0, fraction))
  const count = Math.round(clamped * cells)

  return { filled: '━'.repeat(count), rest: '─'.repeat(cells - count) }
}

export type Run = { text: string; kind: 'fill' | 'rest' | 'mark' }

/**
 * A gauge track with a mark on it: where an even pace would have the fill by
 * now. The mark takes one cell, a tick across the track: heavy inside the
 * fill, light beyond it.
 */
export function track(fraction: number, cells: number, markAt?: number): Run[] {
  const { filled, rest } = bar(fraction, cells)
  const kinds: Run['kind'][] = [
    ...Array.from({ length: filled.length }, () => 'fill' as const),
    ...Array.from({ length: rest.length }, () => 'rest' as const),
  ]
  const glyphs = [...filled, ...rest]

  if (markAt !== undefined && cells > 0) {
    const cell = Math.min(cells - 1, Math.max(0, Math.floor(markAt * cells)))

    glyphs[cell] = kinds[cell] === 'fill' ? '┃' : '│'
    kinds[cell] = 'mark'
  }

  const runs: Run[] = []

  for (const [index, kind] of kinds.entries()) {
    const last = runs[runs.length - 1]
    const glyph = glyphs[index] ?? ''

    if (last !== undefined && last.kind === kind) last.text += glyph
    else runs.push({ text: glyph, kind })
  }

  return runs
}

/** Time until a reset, as short as it reads: 2h13m, 45m, 3d4h. */
export function countdown(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))

  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`

  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const SIGNAL = '▁▂▄▆█'

export type EffortStyle = {
  /** The bars of a signal meter lit up to the level, so it reads like any other. */
  lit: string
  /** The rest of the meter, drawn dim; empty for a level this build does not know. */
  unlit: string
  /** 1 for `low` up to 5 for `max`; 0 when unknown. */
  rank: number
}

/**
 * How an effort level looks: a five-bar signal meter, lit to the level. The
 * meter is the scale, so `xhigh` reads as four of five without knowing the
 * names. A level this build does not know gets no meter, only its word.
 */
export function effortStyle(effort: string): EffortStyle {
  const rank = EFFORT_LEVELS.indexOf(effort) + 1

  if (rank === 0) return { lit: '', unlit: '', rank: 0 }

  return { lit: SIGNAL.slice(0, rank), unlit: SIGNAL.slice(rank), rank }
}

/** `claude-sonnet-5-5` -> `Sonnet 5.5`; a name already readable is left as it is. */
export function prettyModel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[[^\]]*\])?$/.exec(
    model,
  )

  if (match === null) return model

  const [, family = '', major = '', minor, context] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  const version = minor === undefined ? major : `${major}.${minor}`

  return `${name} ${version}${context ?? ''}`
}

/** The terminal's own name for the last path segment of `path`. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')

  return parts[parts.length - 1] ?? path
}

/**
 * Cells a string takes: wide CJK and emoji two, variation selectors and
 * combining marks none. An estimate that errs wide, used to choose a layout,
 * not to paint.
 */
export function width(text: string): number {
  let cells = 0

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0

    if (code === 0xfe0f || code === 0x200d || (code >= 0x300 && code < 0x370)) {
      continue
    }

    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      code === 0x26fd

    cells += isWide ? 2 : 1
  }

  return cells
}
