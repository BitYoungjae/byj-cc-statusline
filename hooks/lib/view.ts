// The band as an element tree: lines of segments, each segment a keyed Box so
// the pointer resting on it reveals its card above, over the rows there,
// without moving anything.
//
// Nothing here touches `$`: the element constructors come in from the drawing
// hook (`$.ui.resolve(e)`), and so do the closures a press runs.

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
import { SEPARATOR_WIDTH, type Card, type Part, type Seg } from './style'

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
}

export type ViewOptions = {
  /** Cells the lines may take, the left margin already taken off. */
  columns: number
  separator: Part
  /** Whether resting the pointer on a segment shows its card. */
  hasCards: boolean
}

/** The widest a card grows; its rows are cut beyond it. */
const CARD_MAX = 60

function style(part: Part): TextProps {
  return {
    ...(part.color === undefined ? {} : { color: part.color }),
    ...(part.bg === undefined ? {} : { backgroundColor: part.bg }),
    ...(part.dim === true ? { dimColor: true } : {}),
    ...(part.bold === true ? { bold: true } : {}),
    ...(part.underline === true ? { underline: true } : {}),
  }
}

function texts(els: Elements, parts: readonly Part[]): RenderElement[] {
  return parts.map(part => els.Text({ ...style(part), children: part.text }))
}

/** The card's size: as wide as its widest row, padded a cell each side, inside a border. */
export function cardSize(card: Card, columns: number): { width: number; height: number; inner: number } {
  const widest = Math.max(width(card.title), ...card.rows.map(row => partsWidth(row)))
  const inner = Math.max(1, Math.min(widest, CARD_MAX, columns - 4))

  return { width: inner + 4, height: card.rows.length + 3, inner }
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
 * One row of a card, padded with spaces to the card's width: a card paints
 * over the rows above the band, and a cell it leaves unwritten would let the
 * text beneath show through.
 */
function cardRow(els: Elements, parts: readonly Part[], inner: number): RenderElement {
  const pad = Math.max(0, inner - partsWidth(parts))

  return els.Text({
    wrap: 'truncate',
    children: [
      els.Text({ children: ' ' }),
      ...texts(els, parts),
      els.Text({ children: `${' '.repeat(pad)} ` }),
    ],
  })
}

/**
 * A card floats clear of the band: its bottom edge sits on the band's top, so
 * it covers the transcript above and never half a line of the band itself.
 */
function card(els: Elements, value: Card, at: { x: number; row: number }, columns: number): RenderElement {
  const size = cardSize(value, columns)

  return els.Box({
    position: 'absolute',
    display: 'none',
    hover: { display: 'flex' },
    top: -(size.height + at.row),
    left: cardLeft(at.x, size.width, columns),
    width: size.width,
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'promptBorder',
    children: [
      cardRow(els, [{ text: value.title, bold: true }], size.inner),
      ...value.rows.map(row => cardRow(els, row, size.inner)),
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
  const children: RenderElement[] = chunkParts(seg.parts).map(chunk => {
    const copying = chunk.copy

    // A click copies what the run shows (or, for a directory, its whole path).
    if (copying !== undefined) {
      return els.Button({
        key: `copy:${copying.id}`,
        plain: true,
        onPress: actions.copy(copying.text),
        children: texts(els, chunk.parts),
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

    return els.Text({ ...(only === undefined ? {} : style(only)), children: only?.text ?? '' })
  })

  if (options.hasCards && seg.card !== undefined) {
    children.push(card(els, seg.card, at, options.columns))
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
