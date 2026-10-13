// The band as an element tree: lines of segments, each segment a keyed Box,
// so the pointer resting on it lights it and reveals its card above, over
// the rows there, without moving anything.
//
// Nothing here touches `$`: the element constructors come in from the drawing
// hook (`$.ui.resolve(e)`), and so do the closures a press runs and the
// surface modules a live part draws with.

import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  RenderElement,
  TextProps,
  UiPressArgument,
} from 'claude-code'

import { chunkParts, partsWidth } from './arrange'
import { width } from './format'
import { SEPARATOR_WIDTH, type Card, type Live, type Part, type Seg } from './style'

export type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type Actions = {
  /** What a press on a copy target runs. */
  copy: (text: string) => (press: UiPressArgument) => void
  /** What the /compact button runs. */
  compact: () => void
  /**
   * The surface module that draws a live part under `key`, or null where the
   * surface has none: the part's own text stands in, still.
   */
  live: (live: Live, key: string) => RenderElement | null
}

export type ViewOptions = {
  /** Cells the lines may take, the left margin already taken off. */
  columns: number
  separator: Part
  /** Whether resting the pointer on a segment shows its card. */
  hasCards: boolean
  /** Behind a segment under the pointer; none leaves it unlit. */
  hover?: string
  /** A card's frame. */
  border: string
}

/** The widest a card's rows grow; past it they are cut. */
const CARD_MAX = 64

function style(part: Part, hover?: string): TextProps {
  return {
    ...(part.color === undefined ? {} : { color: part.color }),
    ...(part.bg === undefined ? {} : { backgroundColor: part.bg }),
    ...(part.dim === true ? { dimColor: true } : {}),
    ...(part.bold === true ? { bold: true } : {}),
    ...(part.underline === true ? { underline: true } : {}),
    // A part with a background of its own (a gauge's track, an alarm) keeps it.
    ...(hover === undefined || part.bg !== undefined ? {} : { hover: { backgroundColor: hover } }),
  }
}

function texts(els: Elements, parts: readonly Part[], hover?: string): RenderElement[] {
  return parts.map(part => els.Text({ ...style(part, hover), children: part.text }))
}

/** `parts` cut to `cells`, the last cell an ellipsis when anything was cut; no room, nothing. */
export function fitParts(parts: readonly Part[], cells: number): Part[] {
  if (cells <= 0) return []
  if (partsWidth(parts) <= cells) return [...parts]

  const out: Part[] = []
  let room = Math.max(0, cells - 1)

  for (const part of parts) {
    if (room <= 0) break

    const chars = [...part.text]
    let kept = ''

    for (const char of chars) {
      const cost = width(char)

      if (cost > room) {
        room = 0
        break
      }

      kept += char
      room -= cost
    }

    if (kept !== '') out.push({ ...part, text: kept })
  }

  out.push({ text: '…', color: 'inactive' })

  return out
}

/** The card's size: as wide as its widest row (or its title rule), padded a cell each side, inside a frame. */
export function cardSize(card: Card, columns: number): { width: number; height: number; inner: number } {
  const rule = width(card.title) + (card.aside === undefined ? 0 : width(card.aside.text) + 3) + 2
  const widest = Math.max(rule, ...card.rows.map(row => partsWidth(row)))
  const inner = Math.max(1, Math.min(widest, CARD_MAX, columns - 4))

  return { width: inner + 4, height: card.rows.length + 2, inner }
}

/**
 * Where the card sits against its segment: over it, left-aligned with it, and
 * pulled left as far as it must to stay inside the band.
 */
export function cardLeft(x: number, cardWidth: number, columns: number): number {
  const overflow = x + cardWidth - columns

  return overflow > 0 ? -Math.min(x, overflow) : 0
}

/**
 * The top rule: the title set into it at the left, the aside at the right.
 * Cut to the card's width when the room is short, never longer.
 */
function topRule(els: Elements, card: Card, size: { width: number; inner: number }, border: string): RenderElement {
  const title = fitParts([{ text: card.title, bold: true }], Math.max(1, size.inner - 2))
  const room = size.inner - partsWidth(title) - 5
  // An aside with no room for two cells of itself is left out, not drawn as a lone `…`.
  const aside = card.aside === undefined || room < 2 ? [] : fitParts([card.aside], room)
  const used = 3 + partsWidth(title) + 1 + (aside.length > 0 ? 1 + partsWidth(aside) + 3 : 2)
  const fill = Math.max(0, size.width - used)

  return els.Text({
    wrap: 'truncate',
    children: [
      els.Text({ color: border, children: '╭─ ' }),
      ...texts(els, title),
      els.Text({ color: border, children: ` ${'─'.repeat(fill)}${aside.length > 0 ? ' ' : '─╮'}` }),
      ...(aside.length > 0 ? [...texts(els, aside), els.Text({ color: border, children: ' ─╮' })] : []),
    ],
  })
}

/**
 * One row of a card, padded with spaces to the card's width: a card paints
 * over the rows above the band, and a cell it leaves unwritten would let the
 * text beneath show through.
 */
function cardRow(els: Elements, parts: readonly Part[], inner: number, border: string): RenderElement {
  const shown = fitParts(parts, inner)
  const pad = Math.max(0, inner - partsWidth(shown))

  return els.Text({
    wrap: 'truncate',
    children: [
      els.Text({ color: border, children: '│ ' }),
      ...texts(els, shown),
      els.Text({ children: ' '.repeat(pad) }),
      els.Text({ color: border, children: ' │' }),
    ],
  })
}

/**
 * A card floats clear of the band: its bottom edge sits on the band's top, so
 * it covers the transcript above and never half a line of the band itself.
 */
function card(els: Elements, value: Card, at: { x: number; row: number }, options: ViewOptions): RenderElement {
  const size = cardSize(value, options.columns)

  return els.Box({
    position: 'absolute',
    display: 'none',
    hover: { display: 'flex' },
    top: -(size.height + at.row),
    left: cardLeft(at.x, size.width, options.columns),
    width: size.width,
    flexDirection: 'column',
    children: [
      topRule(els, value, size, options.border),
      ...value.rows.map(row => cardRow(els, row, size.inner, options.border)),
      els.Text({ color: options.border, children: `╰${'─'.repeat(size.width - 2)}╯` }),
    ],
  })
}

function segment(
  els: Elements,
  seg: Seg,
  at: { x: number; row: number },
  actions: Actions,
  options: ViewOptions,
): RenderElement {
  const { hover } = options
  const children: RenderElement[] = chunkParts(seg.parts).map((chunk, index) => {
    const copying = chunk.copy

    // A click copies what the run shows (or, for a directory, its whole path).
    if (copying !== undefined) {
      return els.Button({
        key: `copy:${copying.id}`,
        plain: true,
        onPress: actions.copy(copying.text),
        children: texts(els, chunk.parts, hover),
      })
    }

    if (chunk.press === 'compact') {
      return els.Button({
        key: 'compact',
        plain: true,
        onPress: () => actions.compact(),
        children: texts(els, chunk.parts),
      })
    }

    const [only] = chunk.parts

    if (chunk.live !== undefined) {
      const drawn = actions.live(chunk.live, `live:${seg.id}:${index}`)

      if (drawn !== null) return drawn
    }

    return els.Text({ ...(only === undefined ? {} : style(only, hover)), children: only?.text ?? '' })
  })

  if (options.hasCards && seg.card !== undefined) {
    children.push(card(els, seg.card, at, options))
  }

  return els.Box({ key: `seg:${seg.id}`, flexDirection: 'row', flexShrink: 0, children })
}

/**
 * One line. Where it holds both groups (a wide band on one line), the
 * metrics sit at the right edge, the identity at the left, and the room
 * between them is the separator.
 */
function line(
  els: Elements,
  segs: readonly Seg[],
  row: number,
  actions: Actions,
  options: ViewOptions,
): RenderElement {
  const split = segs.findIndex(seg => seg.row === 'metrics')
  const hasGroups = split > 0
  const metricsWidth = hasGroups
    ? segs.slice(split).reduce((sum, seg) => sum + partsWidth(seg.parts), 0) +
      SEPARATOR_WIDTH * (segs.length - split - 1)
    : 0
  const children: RenderElement[] = []
  let x = 0

  for (const [index, seg] of segs.entries()) {
    if (index === split && hasGroups) {
      children.push(els.Box({ flexGrow: 1, minWidth: SEPARATOR_WIDTH }))
      x = options.columns - metricsWidth
    } else if (index > 0) {
      children.push(els.Text({ ...style(options.separator), children: options.separator.text }))
      x += SEPARATOR_WIDTH
    }

    children.push(segment(els, seg, { x, row }, actions, options))
    x += partsWidth(seg.parts)
  }

  return els.Box({ flexDirection: 'row', children })
}

/** The whole band: its lines, a cell in from the left so it lines up with the prompt's text. */
export function view(
  els: Elements,
  lines: readonly (readonly Seg[])[],
  actions: Actions,
  options: ViewOptions,
): RenderElement {
  return els.Box({
    flexDirection: 'column',
    paddingLeft: 1,
    children: lines.map((segs, row) => line(els, segs, row, actions, options)),
  })
}
