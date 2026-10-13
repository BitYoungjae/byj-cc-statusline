import { describe, expect, test } from 'claude-code/testing'

import { arrange, chunkParts, lineWidth, plain } from '../hooks/lib/arrange'
import { createTask, EMPTY_ACTIVITY, updateTask } from '../hooks/lib/activity'
import { EMPTY_CACHE, TTL_5M } from '../hooks/lib/cache'
import { build } from '../hooks/lib/segments'
import type { Frame, Part, Seg, Settings } from '../hooks/lib/style'
import { agent, cleanGit, frameOf, NOW, settings, usage, working } from './fixtures'

const ids = (lines: readonly (readonly Seg[])[]) => lines.map(line => line.map(seg => seg.id))
const seg = (frame: Frame, id: string, options: Settings = settings, columns = 400) =>
  arrange(frame, options, columns)
    .flat()
    .find(one => one.id === id)
const text = (parts: readonly Part[] | undefined) => (parts ?? []).map(part => part.text).join('')

describe('layout', () => {
  const frame = frameOf()

  test('a wide terminal gets one line with everything', () => {
    const lines = arrange(frame, settings, 200)

    expect(ids(lines)).toEqual([['model', 'place', 'git', 'fuel', 'five_hour', 'seven_day']])
  })

  test('a middling one gets two lines, context then metrics', () => {
    expect(ids(arrange(frame, settings, 100))).toEqual([
      ['model', 'place', 'git'],
      ['fuel', 'five_hour', 'seven_day'],
    ])
  })

  test('two-line holds even where one would fit', () => {
    expect(arrange(frame, { ...settings, layout: 'two-line' }, 300)).toHaveLength(2)
  })

  test('a narrow one trims detail before it drops anything', () => {
    const lines = arrange(frame, settings, 60)

    expect(ids(lines)).toEqual([
      ['model', 'place', 'git'],
      ['fuel', 'five_hour', 'seven_day'],
    ])

    for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(60)
    // The reset countdowns went first.
    expect(plain(lines[1] ?? [])).not.toContain('2h13m')
  })

  test('each line takes the richest detail it has room for', () => {
    const long = frameOf({ identity: { ...frame.identity, sessionName: 'a-much-longer-renamed-session-name' } })
    const lines = arrange(long, settings, 90)

    // The first line had to trim; the second keeps its countdowns.
    expect(plain(lines[1] ?? [])).toContain('2h13m')
  })

  test('a very narrow one sheds the least wanted first, and never the essentials', () => {
    const lines = arrange(frame, settings, 20)

    expect(lineWidth(lines[1] ?? [])).toBeLessThanOrEqual(20)
    expect(ids(lines)).toEqual([['model', 'place'], ['fuel', 'five_hour']])
  })

  test('the figures keep their room as they change, so the line holds still', () => {
    const at = (percentUsed: number, tokens: number, resetsAt: string) =>
      lineWidth(
        arrange(
          frameOf({ usage: { ...usage, tokens, windows: { ...usage.windows, five_hour: { percentUsed, resetsAt } } } }),
          settings,
          400,
        )[0] ?? [],
      )

    expect(at(7, 10_000, '2026-10-13T12:45:00Z')).toBe(at(66, 45_000, '2026-10-13T14:13:00Z'))
  })

  test('glyphs are ones every coding font has: no fallback, no width surprises', () => {
    const busy = frameOf({
      git: { ...cleanGit, staged: 1, modified: 2, untracked: 3, conflicted: 1, ahead: 1, behind: 2 },
      activity: { ...working, agents: [agent(), agent({ id: 'b', status: 'done', endedAt: NOW })] },
      cache: { ...EMPTY_CACHE, lastRequestAt: NOW - 60_000 },
      isWorking: true,
    })
    const fresh = frameOf({ usage: { ...usage, tokens: null }, cache: { ...EMPTY_CACHE, lastRequestAt: NOW - 3_600_000 } })
    const all = [...arrange(busy, settings, 400), ...arrange(fresh, settings, 400)]
      .flat()
      .flatMap(one => [...one.parts, ...(one.card?.rows.flat() ?? [])])
      .map(part => part.text)
      .join('')
    // Latin-1, box drawing, block elements, and the few others every coding font has.
    const isSafe = (char: string) => {
      const code = char.codePointAt(0) ?? 0

      return code <= 0xff || (code >= 0x2500 && code <= 0x259f) || '↑↓✓…−■'.includes(char)
    }

    expect([...all].filter(char => !isSafe(char))).toEqual([])
  })
})

describe('the badge and the gauges', () => {
  test('the model sits on the badge background, accented', () => {
    const model = seg(frameOf(), 'model')

    expect(model?.parts[0]).toMatchObject({ text: ' Sonnet 5.5 ', color: 'claude', bg: 'userMessageBackground', bold: true })
  })

  test('the gauges are /usage`s: its fill on its track', () => {
    const fuel = seg(frameOf(), 'fuel')

    expect(fuel?.parts.some(part => part.color === 'warning' && part.text.includes('█'))).toBe(true)
    expect(fuel?.parts.some(part => part.bg === 'rate_limit_empty')).toBe(true)

    const window = seg(frameOf(), 'five_hour')

    expect(window?.parts.some(part => part.color === 'rate_limit_fill')).toBe(true)
  })

  test('a surface that knows only the common keys gets those', () => {
    const fuel = seg(frameOf({ isTerminal: false }), 'five_hour')
    const model = seg(frameOf({ isTerminal: false }), 'model')

    expect(fuel?.parts.some(part => part.bg === 'subtle')).toBe(true)
    expect(fuel?.parts.some(part => part.color === 'suggestion')).toBe(true)
    expect(model?.parts[0]?.bg).toBe('subtle')
  })

  test('max effort lights the meter in Claude Code`s own colour for it', () => {
    const model = seg(frameOf({ identity: { ...frameOf().identity, effort: 'max' } }), 'model')

    expect(model?.parts.find(part => part.text === '▁▂▄▆█')?.color).toBe('effortUltra')
    expect(model?.parts.at(-1)).toMatchObject({ text: 'max', bold: true })
  })

  test('a model without effort shows none, and a level unknown to this build shows as it is', () => {
    expect(text(seg(frameOf({ identity: { ...frameOf().identity, effort: null } }), 'model')?.parts)).toBe(' Sonnet 5.5 ')
    expect(text(seg(frameOf({ identity: { ...frameOf().identity, effort: 'turbo' } }), 'model')?.parts)).toBe(' Sonnet 5.5  turbo')
  })

  test('a narrow band keeps the effort word and gives up the meter', () => {
    const narrow = arrange(frameOf(), settings, 40).flat().find(one => one.id === 'model')

    expect(text(narrow?.parts)).not.toContain('▁▂')
    expect(text(narrow?.parts)).toContain('xhigh')
  })
})

describe('what the figures say', () => {
  test('a window past its reset is dimmed and marked, with no countdown', () => {
    const stale = frameOf({
      usage: { ...usage, windows: { ...usage.windows, five_hour: { percentUsed: 64, resetsAt: '2026-10-13T11:00:00Z' } } },
    })
    const window = seg(stale, 'five_hour')

    expect(text(window?.parts)).toContain('~64%')
    expect(window?.parts.find(part => part.text.includes('~64%'))?.dim).toBe(true)
    expect(text(window?.parts)).not.toMatch(/\d+m/)
  })

  test('the pace mark lights up when the pace held would run the window out', () => {
    const hot = frameOf({
      usage: { ...usage, windows: { ...usage.windows, five_hour: { percentUsed: 90, resetsAt: '2026-10-13T14:00:00Z' } } },
    })
    const mark = seg(hot, 'five_hour')?.parts.find(part => part.text === '┃' || part.text === '│')

    expect(mark).toMatchObject({ color: 'warning', bold: true })
  })

  test('before the first response the gauge holds its place with a dash', () => {
    const fuel = seg(frameOf({ usage: { ...usage, tokens: null } }), 'fuel')

    expect(text(fuel?.parts)).toContain('−')
    expect(fuel?.card?.rows[0]?.[0]?.text).toBe('fills in after the first reply')
  })

  test('a renamed session shows the directory and a tag', () => {
    const renamed = frameOf({ identity: { ...frameOf().identity, sessionName: 'fuel-gauge-fix' } })

    expect(ids(arrange(renamed, settings, 300))[0]).toEqual(['model', 'place', 'tag', 'git', 'fuel', 'five_hour', 'seven_day'])
  })

  test('a dirty tree shows its counts, signed', () => {
    const dirty = frameOf({ git: { ...cleanGit, staged: 1, modified: 2, untracked: 3, conflicted: 1, ahead: 1, behind: 2 } })

    expect(text(seg(dirty, 'git')?.parts)).toBe('main !1 +1 ~2 ?3 ↑1 ↓2')
    expect(text(seg(frameOf(), 'git')?.parts)).toBe('main ✓')
  })

  test('low fuel lights the number and offers /compact, but not while a turn runs', () => {
    const low = frameOf({ usage: { ...usage, tokens: 150_000 } })
    const fuel = seg(low, 'fuel')

    expect(fuel?.parts[0]).toEqual({ text: 'fuel ', color: 'error' })
    expect(fuel?.parts.find(part => part.bg === 'error')).toMatchObject({ color: 'inverseText', bold: true })
    expect(fuel?.parts.find(part => part.press === 'compact')?.text).toBe('/compact')
    expect(seg({ ...low, isWorking: true }, 'fuel')?.parts.some(part => part.press === 'compact')).toBe(false)
    expect(seg(frameOf(), 'fuel')?.parts.some(part => part.press === 'compact')).toBe(false)
  })

  test('the emoji look is the original`s', () => {
    const emoji = { ...settings, icons: 'emoji' as const }
    const all = arrange(frameOf(), emoji, 400).map(plain).join('\n')

    expect(all).toContain('🤖 Sonnet 5.5')
    expect(all).toContain('🧠 xhigh')
    expect(all).toContain('⛽ ')
    expect(seg(frameOf({ usage: { ...usage, tokens: 150_000 } }), 'fuel', emoji)?.parts[0]?.text).toBe('⚠️ ')
  })

  test('the cost shows only when asked for', () => {
    expect(seg(frameOf(), 'cost')).toBeUndefined()
    expect(text(seg(frameOf(), 'cost', { ...settings, showCost: true })?.parts)).toBe('$0.42')
  })
})

describe('the prompt cache', () => {
  const warm = { ...EMPTY_CACHE, lastRequestAt: NOW - 48_000, ttlMs: TTL_5M, tokens: 104_000, hitRatio: 0.94 }

  test('between turns it counts down on the surface', () => {
    const cache = seg(frameOf({ cache: warm }), 'cache')
    const clock = cache?.parts.find(part => part.live !== undefined)

    expect(clock?.text).toBe('4:12')
    expect(clock?.live).toMatchObject({ kind: 'clock', direction: 'down', ms: 252_000, doneText: 'cold', doneColor: 'warning' })
  })

  test('while a turn runs there is nothing to count', () => {
    expect(seg(frameOf({ cache: warm, isWorking: true }), 'cache')).toBeUndefined()
  })

  test('before any request, or switched off, there is no segment', () => {
    expect(seg(frameOf(), 'cache')).toBeUndefined()
    expect(seg(frameOf({ cache: warm }), 'cache', { ...settings, hasCache: false })).toBeUndefined()
  })

  test('a lapsed entry is cold; a small one is cold without alarm', () => {
    const cold = seg(frameOf({ cache: { ...warm, lastRequestAt: NOW - 10 * 60_000 } }), 'cache')

    expect(cold?.parts.at(-1)).toEqual({ text: 'cold', color: 'warning' })
    expect(seg(frameOf({ cache: { ...warm, lastRequestAt: NOW - 10 * 60_000, tokens: 5_000 } }), 'cache')?.parts.at(-1)?.color).toBe('inactive')
  })

  test('its card says how long entries live and what lapsing costs', () => {
    const card = seg(frameOf({ cache: warm }), 'cache')?.card
    const rows = card?.rows.map(row => text(row)) ?? []

    expect(card?.aside?.text).toBe('4:12 left')
    expect(rows[0]).toBe('an entry lives 5 minutes unread (assumed)')
    expect(rows[1]).toBe('last request just now · 94% of it read from the cache')
    expect(rows[2]).toBe('reply within 4:12 and 104K reads back at 1/10 the price')
  })
})

describe('the activity line', () => {
  test('there is none while nothing goes on', () => {
    expect(arrange(frameOf(), settings, 300)).toHaveLength(1)
  })

  test('while a turn runs it goes under the band: the tool running, then the tally', () => {
    const lines = arrange(frameOf({ activity: working, isWorking: true }), settings, 300)

    expect(ids(lines)).toEqual([
      ['model', 'place', 'git', 'fuel', 'five_hour', 'seven_day'],
      ['now', 'tally'],
    ])
    expect(plain(lines[1] ?? [])).toBe('▖ Edit view.ts · Read ×4  Grep ×2  Bash ×1!')
    expect(lines[1]?.[0]?.parts[0]?.live).toEqual({ kind: 'spinner', color: 'claude' })
  })

  test('with no tool in flight the model is thinking', () => {
    const line = arrange(frameOf({ activity: EMPTY_ACTIVITY, isWorking: true }), settings, 300)[1]

    expect(plain(line ?? [])).toBe('▖ thinking')
  })

  test('a subagent shows with its clock, live while it runs', () => {
    const line = arrange(frameOf({ activity: { ...EMPTY_ACTIVITY, agents: [agent()] } }), settings, 300)[1]
    const agents = line?.find(one => one.id === 'agents')

    expect(plain(line ?? [])).toBe('■ Explore find the hooks 0:34 ')
    expect(agents?.parts.find(part => part.live !== undefined)?.live).toMatchObject({ kind: 'clock', direction: 'up', ms: 34_000 })
  })

  test('a finished one keeps its time, still', () => {
    const done = agent({ status: 'done', endedAt: NOW - 4_000 })
    const line = arrange(frameOf({ activity: { ...EMPTY_ACTIVITY, agents: [done] } }), settings, 300)[1]

    expect(plain(line ?? [])).toBe('✓ Explore find the hooks 0:30')
    expect(line?.[0]?.parts.some(part => part.live !== undefined)).toBe(false)
  })

  test('several agents show the first two and how many more', () => {
    const agents = [agent({ id: '1' }), agent({ id: '2', type: 'Plan' }), agent({ id: '3' })]
    const line = arrange(frameOf({ activity: { ...EMPTY_ACTIVITY, agents } }), settings, 300)[1]

    expect(plain(line ?? [])).toBe('■ Explore 0:34   ■ Plan 0:34   +1')
  })

  test('tasks show their progress and the one under way', () => {
    let tasks = createTask([], '1', 'Survey', 'Surveying the code')

    tasks = createTask(tasks, '2', 'Count', null)
    tasks = updateTask(tasks, { taskId: '1', status: 'completed' })
    tasks = updateTask(tasks, { taskId: '2', status: 'in_progress' })

    const line = arrange(frameOf({ activity: { ...EMPTY_ACTIVITY, tasks }, isWorking: true }), settings, 300)[1]
    const task = line?.find(one => one.id === 'tasks')

    expect(text(task?.parts)).toBe('tasks ███    1/2 Count')
    expect(task?.card?.rows.map(row => text(row))).toEqual(['✓ Survey', '» Count'])
  })

  test('a task list waiting between turns stays out of the way', () => {
    const tasks = createTask([], '1', 'Survey', null)

    expect(arrange(frameOf({ activity: { ...EMPTY_ACTIVITY, tasks } }), settings, 300)).toHaveLength(1)
  })

  test('switched off, it never shows', () => {
    expect(arrange(frameOf({ activity: working, isWorking: true }), { ...settings, hasActivity: false }, 300)).toHaveLength(1)
  })

  test('a narrow line trims, then sheds the tally first', () => {
    const busy = frameOf({ activity: { ...working, agents: [agent()] }, isWorking: true })
    const narrow = arrange(busy, settings, 24).at(-1) ?? []

    expect(lineWidth(narrow)).toBeLessThanOrEqual(24)
    expect(narrow.map(one => one.id)).toContain('now')
    expect(narrow.map(one => one.id)).not.toContain('tally')
  })
})

describe('chunks', () => {
  test('a glyph and its name are one copy target; a live part is its own', () => {
    const copy = { id: 'model', text: 'm' }
    const chunks = chunkParts([
      { text: '🤖 ', copy },
      { text: 'Model', copy },
      { text: ' ' },
      { text: '4:12', live: { kind: 'clock', ms: 1, direction: 'down', width: 4 } },
      { text: '' },
    ])

    expect(chunks.map(chunk => chunk.parts.map(part => part.text).join(''))).toEqual(['🤖 Model', ' ', '4:12'])
    expect(chunks[2]?.live?.kind).toBe('clock')
  })

  test('every segment is built at each detail without surprises', () => {
    for (const detail of [0, 1, 2] as const) {
      const segs = build(frameOf({ activity: working, isWorking: true }), settings, detail)

      expect(segs.length).toBeGreaterThan(0)
    }
  })
})
