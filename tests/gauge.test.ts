import { describe, expect, test } from 'claude-code/testing'

import { eighths, gauge, mixGauge, sparkline } from '../hooks/lib/gauge'
import type { Part } from '../hooks/lib/style'

const colors = { fill: 'rate_limit_fill', track: 'rate_limit_empty' }
const text = (parts: readonly Part[]) => parts.map(part => part.text).join('')

describe('gauge', () => {
  test('fills by eighths of a cell', () => {
    expect(eighths(0.5, 4)).toEqual([8, 8, 0, 0])
    expect(eighths(0.45, 10)).toEqual([8, 8, 8, 8, 4, 0, 0, 0, 0, 0])
    expect(eighths(1, 3)).toEqual([8, 8, 8])
    expect(eighths(0, 3)).toEqual([0, 0, 0])
  })

  test('anything over nothing shows at least a sliver', () => {
    expect(eighths(0.001, 10)[0]).toBe(1)
  })

  test('out of range is held to the gauge', () => {
    expect(eighths(1.7, 2)).toEqual([8, 8])
    expect(eighths(-1, 2)).toEqual([0, 0])
    expect(eighths(Number.NaN, 2)).toEqual([0, 0])
  })

  test('the fill sits on its track: the cell where it ends joins both without a seam', () => {
    expect(gauge(0.45, 10, colors)).toEqual([
      { text: '████', color: 'rate_limit_fill' },
      { text: '▌', color: 'rate_limit_fill', bg: 'rate_limit_empty' },
      { text: '     ', bg: 'rate_limit_empty' },
    ])
  })

  test('is as wide as its cells whatever the fraction', () => {
    for (const fraction of [0, 0.01, 0.33, 0.5, 0.99, 1, 2]) {
      expect(text(gauge(fraction, 8, colors))).toHaveLength(8)
    }
  })

  test('the pace mark is a tick over the fill or over the track, whichever is there', () => {
    const over = gauge(0.5, 8, colors, { at: 0.25, color: 'text' })
    const past = gauge(0.25, 8, colors, { at: 0.75, color: 'warning', bold: true })

    expect(text(over)).toBe('██┃█    ')
    expect(over[1]).toEqual({ text: '┃', color: 'text', bg: 'rate_limit_fill' })
    expect(text(past)).toBe('██    │ ')
    expect(past.find(part => part.text === '│')).toEqual({ text: '│', color: 'warning', bg: 'rate_limit_empty', bold: true })
  })

  test('a mark at the very end stays on the gauge', () => {
    expect(text(gauge(0, 4, colors, { at: 1, color: 'text' }))).toBe('   │')
  })

  test('no cells, no gauge', () => {
    expect(gauge(0.5, 0, colors)).toEqual([])
  })
})

describe('context mix', () => {
  const parts = [
    { name: 'Messages', tokens: 60_000, color: 'permission' },
    { name: 'System tools', tokens: 20_000, color: 'inactive' },
    { name: 'Memory', tokens: 500, color: 'claude' },
  ]

  test('each kind in its colour, then the free room, then the reserve hatched', () => {
    const mix = mixGauge(parts, 200_000, 167_000, 20, { ...colors, reserve: 'warning' })

    expect(text(mix)).toHaveLength(20)
    expect(mix[0]).toEqual({ text: '██████', color: 'permission' })
    expect(mix[1]).toEqual({ text: '██', color: 'inactive' })
    // Half a thousand tokens is under a cell, and still gets one.
    expect(mix[2]).toEqual({ text: '█', color: 'claude' })
    // 33K of reserve in 10K cells.
    expect(mix.at(-1)).toEqual({ text: '░░░', color: 'warning', bg: 'rate_limit_empty' })
  })

  test('nothing to break down draws nothing', () => {
    expect(mixGauge([], 200_000, 167_000, 20, { ...colors, reserve: 'warning' })).toEqual([])
  })
})

describe('sparkline', () => {
  test('is drawn on the scale of the whole tank, not the largest value', () => {
    // A context holding at half full is half-height bars, not a wall.
    expect(sparkline([50, 50, 50], 100)).toBe('▅▅▅')
    expect(sparkline([0, 25, 50, 100], 100)).toBe('▁▃▅█')
  })

  test('a value past the top is a full bar', () => {
    expect(sparkline([150], 100)).toBe('█')
    expect(sparkline([1], 0)).toBe('')
  })
})
