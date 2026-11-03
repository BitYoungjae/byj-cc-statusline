import { describe, expect, test } from 'claude-code/testing'

import { mergeWindows, toWindows, WINDOW_SPAN_MS } from '../hooks/lib/windows'

const NOW = Date.parse('2026-11-03T12:00:00Z')

/** A remembered window that reset `ago` milliseconds ago. */
const remembered = (kind: 'five_hour' | 'seven_day', ago: number) => ({
  five_hour: kind === 'five_hour' ? { percentUsed: 80, resetsAt: new Date(NOW - ago).toISOString() } : null,
  seven_day: kind === 'seven_day' ? { percentUsed: 45, resetsAt: new Date(NOW - ago).toISOString() } : null,
})

describe('merging the live readings', () => {
  test('live wins, whatever is remembered', () => {
    const was = remembered('five_hour', 0)

    expect(
      mergeWindows(was, [{ kind: 'five_hour', percentUsed: 7, resetsAt: new Date(NOW + 3_600_000).toISOString() }], NOW),
    ).toEqual({
      five_hour: { percentUsed: 7, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      seven_day: null,
    })
  })

  test('other kinds a plan might grow are passed over', () => {
    expect(mergeWindows(remembered('five_hour', 0), [{ kind: 'daily', percentUsed: 1, resetsAt: null }], NOW).five_hour).not.toBeNull()
  })

  test('a live reading without a date is kept: it is live', () => {
    expect(mergeWindows({ five_hour: null, seven_day: null }, [{ kind: 'seven_day', percentUsed: 30 }], NOW).seven_day).toEqual({
      percentUsed: 30,
      resetsAt: null,
    })
  })
})

describe('a remembered window, bridging', () => {
  test('one that just reset stays until the next report', () => {
    expect(mergeWindows(remembered('five_hour', 60_000), [], NOW).five_hour).toEqual({
      percentUsed: 80,
      resetsAt: new Date(NOW - 60_000).toISOString(),
    })
  })

  test('one reset by less than the window is long still bridges', () => {
    expect(mergeWindows(remembered('five_hour', WINDOW_SPAN_MS.five_hour - 1), [], NOW).five_hour).not.toBeNull()
    expect(mergeWindows(remembered('seven_day', WINDOW_SPAN_MS.seven_day - 1), [], NOW).seven_day).not.toBeNull()
  })

  test('one reset by more than the window is long is dropped: it cannot be the current window, and a plan without it never reports it again', () => {
    expect(mergeWindows(remembered('five_hour', WINDOW_SPAN_MS.five_hour + 1), [], NOW).five_hour).toBeNull()
    expect(mergeWindows(remembered('seven_day', WINDOW_SPAN_MS.seven_day + 1), [], NOW).seven_day).toBeNull()
  })

  test('one a live reading replaces this call is not bridged, it is gone', () => {
    const was = mergeWindows(remembered('five_hour', WINDOW_SPAN_MS.five_hour + 1), [{ kind: 'seven_day', percentUsed: 30, resetsAt: null }], NOW)

    expect(was.five_hour).toBeNull()
    expect(was.seven_day).not.toBeNull()
  })

  test('one without a date cannot be told apart from a dead one, and goes', () => {
    expect(mergeWindows({ five_hour: { percentUsed: 80, resetsAt: null }, seven_day: null }, [], NOW).five_hour).toBeNull()
  })
})

describe('what the store kept', () => {
  test('readings are a number and a date, or nothing', () => {
    expect(toWindows({ five_hour: { percentUsed: 7, resetsAt: '2026-11-03T14:00:00Z' } })).toEqual({
      five_hour: { percentUsed: 7, resetsAt: '2026-11-03T14:00:00Z' },
      seven_day: null,
    })
    expect(toWindows({ five_hour: { resetsAt: 'x' } })).toEqual({ five_hour: null, seven_day: null })
    expect(toWindows('nope')).toEqual({ five_hour: null, seven_day: null })
  })
})
