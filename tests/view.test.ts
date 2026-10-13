import { describe, expect, test } from 'claude-code/testing'

import { arrange, partsWidth } from '../hooks/lib/arrange'
import { EMPTY_CACHE } from '../hooks/lib/cache'
import { separatorPart, type Live } from '../hooks/lib/style'
import { cardLeft, cardSize, fitParts, view, type Actions } from '../hooks/lib/view'
import { cleanGit, frameOf, NOW, settings, working } from './fixtures'

type Node = { type: string; props: Record<string, unknown> }

const el = (type: string) => (props: object) => ({ type, props }) as never
const els = { Box: el('Box'), Text: el('Text'), Button: el('Button') }
const lived: { live: Live; key: string }[] = []
const actions: Actions = {
  copy: () => () => {},
  compact: () => {},
  live: (live, key) => {
    lived.push({ live, key })

    return { type: 'Client', props: { key } } as never
  },
}

function walk(node: Node, out: Node[] = []): Node[] {
  out.push(node)

  const children = node.props.children

  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'object' && child !== null) walk(child as Node, out)
  }

  return out
}

/** A Text's own words, its nested Texts' joined. */
function said(node: Node): string {
  const children = node.props.children

  return (Array.isArray(children) ? children : [children])
    .map(child => (typeof child === 'string' ? child : typeof child === 'object' && child !== null ? said(child as Node) : ''))
    .join('')
}

const options = (hasCards: boolean) => ({
  columns: 160,
  separator: separatorPart(settings),
  hasCards,
  hover: 'userMessageBackgroundHover',
  border: 'promptBorder',
})

function tree(frame = frameOf(), hasCards = true, act: Actions = actions): Node[] {
  return walk(view(els, arrange(frame, settings, 160), act, options(hasCards)) as unknown as Node)
}

describe('the tree', () => {
  test('each segment is a keyed box, its card hidden until the pointer rests on it', () => {
    const nodes = tree()
    const cards = nodes.filter(node => node.props.position === 'absolute')

    expect(nodes.some(node => node.props.key === 'seg:model')).toBe(true)
    expect(cards.length).toBeGreaterThan(0)

    for (const card of cards) {
      expect(card.props.display).toBe('none')
      expect(card.props.hover).toEqual({ display: 'flex' })
    }
  })

  test('no cards when they are switched off', () => {
    expect(tree(frameOf(), false).some(node => node.props.position === 'absolute')).toBe(false)
  })

  test('a segment lights under the pointer, but a gauge keeps its track', () => {
    const nodes = tree()
    const lit = nodes.filter(node => node.type === 'Text' && node.props.hover !== undefined)

    expect(lit.length).toBeGreaterThan(0)
    expect(lit.every(node => node.props.backgroundColor === undefined)).toBe(true)
    expect(nodes.some(node => node.props.backgroundColor === 'rate_limit_empty' && node.props.hover === undefined)).toBe(true)
  })

  test('names copy on a click: the model, the place, the branch', () => {
    const keys = tree()
      .filter(node => node.type === 'Button')
      .map(node => node.props.key)

    expect(keys).toEqual(['copy:model', 'copy:place', 'copy:branch'])
  })

  test('a live part is the surface module`s; where there is none, its own text stands in', () => {
    lived.length = 0

    const frame = frameOf({ activity: working, isWorking: true })
    const nodes = tree(frame)

    expect(lived.map(one => one.live.kind)).toContain('spinner')
    expect(nodes.some(node => node.type === 'Client')).toBe(true)

    const bare = tree(frame, true, { ...actions, live: () => null })

    expect(bare.some(node => node.type === 'Client')).toBe(false)
    expect(bare.some(node => node.type === 'Text' && node.props.children === '▖')).toBe(true)
  })

  test('the cache clock is keyed by its segment, so it keeps ticking across redraws', () => {
    lived.length = 0
    tree(frameOf({ cache: { ...EMPTY_CACHE, lastRequestAt: NOW - 10_000 } }))

    expect(lived.map(one => one.key)).toEqual(['live:cache:1'])
  })
})

describe('cards', () => {
  test('a card is framed, its title set into the top rule and its figure at the right end', () => {
    const card = tree().find(node => node.props.position === 'absolute' && said(node).includes('Context'))
    const rows = (card?.props.children as Node[]).map(said)
    const size = card?.props.width

    expect(rows[0]).toMatch(/^╭─ Context ─+ 34% left ─╮$/)
    expect(rows.at(-1)).toMatch(/^╰─+╯$/)

    for (const row of rows) expect([...row].length).toBe(size)
    for (const row of rows.slice(1, -1)) expect(row).toMatch(/^│ .* │$/)
  })

  test('a card stays inside the band', () => {
    expect(cardLeft(10, 30, 100)).toBe(0)
    expect(cardLeft(90, 30, 100)).toBe(-20)
    // Wider than the band: pinned to its left edge.
    expect(cardLeft(5, 200, 100)).toBe(-5)
  })

  test('a card is as wide as its widest row or its title rule, inside its frame', () => {
    expect(cardSize({ title: 'abc', rows: [[{ text: 'abcdefgh' }]] }, 100)).toEqual({ width: 12, height: 3, inner: 8 })
    // The title and its figure need their room in the rule.
    expect(cardSize({ title: 'Context', aside: { text: '34% left' }, rows: [[{ text: 'x' }]] }, 100).inner).toBe(20)
  })

  test('a row too long for the card is cut, the last cell an ellipsis', () => {
    const cut = fitParts([{ text: 'abc', bold: true }, { text: 'defgh' }], 6)

    expect(cut.map(part => part.text)).toEqual(['abc', 'de', '…'])
    expect(partsWidth(cut)).toBe(6)
    expect(fitParts([{ text: 'abc' }], 6)).toEqual([{ text: 'abc' }])
    expect(fitParts([{ text: 'abc' }], 0)).toEqual([])
  })

  test('a long title leaves its figure out rather than break the frame', () => {
    const long = frameOf({ git: { ...cleanGit, branch: 'feature/some-long-branch-name-here-and-more-of-it' } })

    for (const columns of [40, 160]) {
      const nodes = walk(view(els, arrange(long, settings, columns), actions, { ...options(true), columns }) as unknown as Node)

      for (const card of nodes.filter(node => node.props.position === 'absolute')) {
        for (const row of (card.props.children as Node[]).map(said)) expect([...row].length).toBe(card.props.width)
      }
    }
  })
})
