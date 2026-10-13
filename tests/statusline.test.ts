import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import type { GitInfo, Usage } from '../types'
import {
  bar,
  baseName,
  clip,
  countdown,
  effortStyle,
  fuel,
  pace,
  prettyModel,
  safeLimit,
  tokens,
  tokensFine,
  track,
  turnsLeft,
  usageLevel,
  width,
} from '../hooks/lib/format'
import { isClean, parseGitStatus } from '../hooks/lib/git'
import { arrange, chunkParts, lineWidth, plain } from '../hooks/lib/arrange'
import { build } from '../hooks/lib/segments'
import { separatorPart, type Frame, type Part, type Seg, type Settings } from '../hooks/lib/style'
import { cardLeft, cardSize, view } from '../hooks/lib/view'
import {
  parseEntry,
  pickName,
  placeName,
  registryFiles,
} from '../hooks/lib/session-name'
import { effortSetting } from '../hooks/lib/settings'

describe('fuel gauge', () => {
  test('is the share of the safe limit still free', () => {
    // 200K window, auto-compact on: safe limit 167K. 110K used leaves 57K, 34%.
    const reading = fuel(110_000, 200_000, true)

    expect(reading?.remaining).toBe(57_000)
    expect(reading?.percent).toBe(34)
    expect(reading?.level).toBe('warn')
  })

  test('reserves a smaller buffer when auto-compact is off', () => {
    // Safe limit 197K, so the same 110K leaves 87K.
    expect(fuel(110_000, 200_000, false)?.remaining).toBe(87_000)
  })

  test('turns red under 30% and green from 70%', () => {
    expect(fuel(10_000, 200_000, true)?.level).toBe('good')
    expect(fuel(150_000, 200_000, true)?.level).toBe('bad')
  })

  test('has no reading before the first response', () => {
    expect(fuel(null, 200_000, true)).toBeNull()
  })

  test('is empty, not negative, past the safe limit', () => {
    const reading = fuel(190_000, 200_000, true)

    expect(reading?.percent).toBe(0)
    expect(reading?.remaining).toBe(0)
    expect(reading?.level).toBe('bad')
  })

  test('usage windows run the other way: more is worse', () => {
    expect(usageLevel(20)).toBe('good')
    expect(usageLevel(50)).toBe('warn')
    expect(usageLevel(80)).toBe('bad')
  })
})

describe('formatting', () => {
  test('tokens read as K above a thousand', () => {
    expect(tokens(57_000)).toBe('57K')
    expect(tokens(900)).toBe('900')
  })

  test('countdowns are as short as they read', () => {
    expect(countdown(45 * 60_000)).toBe('45m')
    expect(countdown((2 * 60 + 13) * 60_000)).toBe('2h13m')
    expect(countdown((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
    expect(countdown(1_000)).toBe('1m')
  })

  test('a bar is as long as its cells whatever the fraction', () => {
    expect(bar(0.34, 10)).toEqual({ filled: '━━━', rest: '──────' + '─' })
    expect(bar(2, 4)).toEqual({ filled: '━━━━', rest: '' })
    expect(bar(-1, 4)).toEqual({ filled: '', rest: '────' })
  })

  test('model ids read as names, and names are left alone', () => {
    expect(prettyModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5[1m]')
    expect(prettyModel('Sonnet 4.5')).toBe('Sonnet 4.5')
  })

  test('the directory is the last path segment', () => {
    expect(baseName('/home/me/Work/my-project')).toBe('my-project')
    expect(baseName('/home/me/Work/my-project/')).toBe('my-project')
  })

  test('wide characters take two cells', () => {
    expect(width('abc')).toBe(3)
    expect(width('프로젝트')).toBe(8)
    expect(width('⚠️')).toBe(1)
  })
})

describe('the engine`s compaction point', () => {
  test('stands in for the fixed buffer once the engine has said where it is', () => {
    expect(safeLimit(200_000, true, 160_000)).toBe(160_000)
    expect(safeLimit(200_000, true, null)).toBe(167_000)
    // Off, there is no compaction point to go by: the small floor.
    expect(safeLimit(200_000, false, 160_000)).toBe(197_000)
    expect(fuel(100_000, 200_000, true, 160_000)?.remaining).toBe(60_000)
  })
})

describe('growth', () => {
  test('room left over the recent turns` average growth', () => {
    // Growth of 10K, 12K and 14K: 12K a turn, so 60K is room for five.
    expect(turnsLeft(60_000, [40_000, 50_000, 62_000, 76_000])).toBe(5)
  })

  test('a compaction`s drop is not a turn`s growth', () => {
    expect(turnsLeft(100_000, [150_000, 30_000, 40_000])).toBe(10)
  })

  test('no growth, no guess', () => {
    expect(turnsLeft(60_000, [])).toBeNull()
    expect(turnsLeft(60_000, [50_000])).toBeNull()
    expect(turnsLeft(60_000, [50_000, 40_000])).toBeNull()
  })
})

describe('pace', () => {
  const span = 5 * 3_600_000
  const now = 1_000_000_000

  test('a window burning ahead of its clock runs out before the reset', () => {
    // 3h of 5h gone (60%), 90% used: 10% more takes 20 minutes, reset is in 2h.
    const step = pace(90, now + 2 * 3_600_000, now, span)

    expect(Math.round((step?.elapsed ?? 0) * 100)).toBe(60)
    expect(Math.round(step?.runsOutInMs ?? 0)).toBe(20 * 60_000)
  })

  test('one keeping behind its clock lasts, and says where it lands', () => {
    const step = pace(30, now + 2.5 * 3_600_000, now, span)

    expect(step?.runsOutInMs).toBeNull()
    expect(Math.round(step?.projected ?? 0)).toBe(60)
  })

  test('too early in a window there is no call', () => {
    expect(pace(10, now + 4.9 * 3_600_000, now, span)).toBeNull()
  })

  test('a window past its reset has no pace', () => {
    expect(pace(50, now - 1, now, span)).toBeNull()
  })
})

describe('text', () => {
  test('a long name loses its middle, where names are least distinct', () => {
    expect(clip('feature/fuel-gauge-for-the-statusline', 16)).toBe('feature/…tusline')
    expect(width(clip('feature/fuel-gauge-for-the-statusline', 16))).toBe(16)
    expect(clip('main', 16)).toBe('main')
  })

  test('fine token counts keep a decimal while it says something', () => {
    expect(tokensFine(12_400)).toBe('12.4K')
    expect(tokensFine(57_000)).toBe('57K')
    expect(tokensFine(167_000)).toBe('167K')
    expect(tokensFine(1_250_000)).toBe('1.3M')
    expect(tokensFine(900)).toBe('900')
  })

  test('the pace mark is one cell of the track, heavy in the fill and light past it', () => {
    expect(track(0.5, 8, 0.25)).toEqual([
      { text: '━━', kind: 'fill' },
      { text: '┃', kind: 'mark' },
      { text: '━', kind: 'fill' },
      { text: '────', kind: 'rest' },
    ])
    expect(track(0.25, 8, 0.75).map(run => run.text).join('')).toBe('━━────│─')
    expect(track(0.25, 8).map(run => run.text).join('')).toBe('━━──────')
  })
})

describe('the effort in the settings', () => {
  test('is kept per model', () => {
    const saved = {
      modelSettings: {
        'claude-opus-5-5': { effortLevel: 'xhigh' },
        'claude-sonnet-5-5': { effortLevel: 'medium' },
      },
    }

    expect(effortSetting(saved, 'claude-opus-5-5')).toBe('xhigh')
    expect(effortSetting(saved, 'claude-sonnet-5-5')).toBe('medium')
    // A context suffix on the id still finds the model's entry.
    expect(effortSetting(saved, 'claude-opus-5-5[1m]')).toBe('xhigh')
  })

  test('falls back on the older top-level key, else none', () => {
    expect(effortSetting({ effortLevel: 'high' }, 'claude-opus-5-5')).toBe('high')
    expect(effortSetting({ modelSettings: {} }, 'claude-haiku-5-5')).toBeNull()
    expect(effortSetting(null, 'claude-opus-5-5')).toBeNull()
  })
})

describe('git status', () => {
  const dirty = [
    '# branch.oid 0aab063c1d2e3f40aab063c1d2e3f40aab063c1',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
    '1 .M N... 100644 100644 100644 aaa bbb edited.ts',
    '1 MM N... 100644 100644 100644 aaa bbb both.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.ts',
    '? new.ts',
    '? other.ts',
    '',
  ].join('\n')

  test('counts files by kind, a file in both states once under each', () => {
    expect(parseGitStatus(dirty)).toEqual({
      branch: 'main',
      isDetached: false,
      staged: 2,
      modified: 2,
      untracked: 2,
      conflicted: 1,
      ahead: 2,
      behind: 1,
    })
  })

  test('a clean tree is clean', () => {
    const clean = parseGitStatus('# branch.oid abc\n# branch.head main\n')

    expect(clean === null ? false : isClean(clean)).toBe(true)
  })

  test('a detached head names the commit', () => {
    const detached = parseGitStatus(
      '# branch.oid 0aab063c1d2e3f4\n# branch.head (detached)\n',
    )

    expect(detached?.branch).toBe('0aab063')
    expect(detached?.isDetached).toBe(true)
  })

  test('output that is no repository is nothing', () => {
    expect(parseGitStatus('')).toBeNull()
  })
})

describe('session name', () => {
  const entry = (sessionId: string, name: string, updatedAt: number) =>
    JSON.stringify({ sessionId, name, updatedAt })

  test('a derived name takes the directory`s place', () => {
    expect(placeName('my-project', 'my-project-a4')).toEqual({
      place: 'my-project-a4',
      tag: null,
    })
    expect(placeName('my-project', 'my-project')).toEqual({
      place: 'my-project',
      tag: null,
    })
  })

  test('a renamed session keeps the directory and gets a tag', () => {
    expect(placeName('my-project', 'fuel-gauge-fix')).toEqual({
      place: 'my-project',
      tag: 'fuel-gauge-fix',
    })
  })

  test('a directory that only starts the same is not covered', () => {
    expect(placeName('app', 'application-3')).toEqual({
      place: 'app',
      tag: 'application-3',
    })
  })

  test('no name leaves the directory alone', () => {
    expect(placeName('my-project', null)).toEqual({
      place: 'my-project',
      tag: null,
    })
  })

  test('the latest update wins when a resume left an old file behind', () => {
    const entries = [
      parseEntry(entry('s1', 'old-name', 100)),
      parseEntry(entry('s1', 'new-name', 200)),
      parseEntry(entry('s2', 'someone-else', 900)),
    ]

    expect(pickName(entries, 's1')).toBe('new-name')
  })

  test('a file cut off mid-write costs only itself', () => {
    const entries = [
      parseEntry('{"sessionId":"s1","na'),
      parseEntry(entry('s1', 'still-found', 5)),
    ]

    expect(entries[0]).toBeNull()
    expect(pickName(entries, 's1')).toBe('still-found')
  })

  test('only <pid>.json files are read, newest first', () => {
    const files = registryFiles([
      { name: '21081.json', mtimeMs: 10 },
      { name: '21081.a43e.key', mtimeMs: 99 },
      { name: '31031.json', mtimeMs: 30 },
      { name: 'notes.txt', mtimeMs: 50 },
    ])

    expect(files).toEqual(['31031.json', '21081.json'])
  })
})

describe('layout', () => {
  const settings: Settings = { layout: 'auto', icons: 'symbols', showCost: false }
  const now = Date.parse('2026-10-13T12:00:00Z')
  const git: GitInfo = {
    branch: 'main',
    isDetached: false,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    ahead: 0,
    behind: 0,
  }
  const usage: Usage = {
    tokens: 110_000,
    window: 200_000,
    isAutoCompact: true,
    compactAt: null,
    parts: [],
    history: [],
    costUsd: 0.42,
    windows: {
      five_hour: { percentUsed: 20, resetsAt: '2026-10-13T14:13:00Z' },
      seven_day: { percentUsed: 45, resetsAt: '2026-10-16T16:00:00Z' },
    },
  }
  const frame: Frame = {
    identity: {
      model: 'Sonnet 5.5',
      effort: 'xhigh',
      dir: 'my-project',
      cwd: '/home/me/Work/my-project',
      sessionName: 'my-project-a4',
    },
    git,
    usage,
    now,
    isWorking: false,
  }

  test('a wide terminal gets one line with everything', () => {
    const [only, ...rest] = arrange(frame, settings, 200)

    expect(rest).toHaveLength(0)

    const text = plain(only ?? [])

    expect(text).toContain('Sonnet 5.5')
    expect(text).toContain('my-project-a4')
    expect(text).toContain('main ✓')
    expect(text).toContain('34%')
    expect(text).toContain('57K left')
    expect(text).toContain('5h')
    expect(text).toContain('(2h13m)')
    expect(text).toContain('(3d4h)')
  })

  test('a middling one gets two lines, context then metrics', () => {
    const lines = arrange(frame, settings, 90)

    expect(lines).toHaveLength(2)
    expect(plain(lines[0] ?? [])).toContain('main')
    expect(plain(lines[1] ?? [])).toContain('fuel')
    expect(plain(lines[1] ?? [])).toContain('7d')
  })

  test('two-line holds even where one would fit', () => {
    expect(arrange(frame, { ...settings, layout: 'two-line' }, 200)).toHaveLength(2)
  })

  test('a narrow one trims detail before it drops anything', () => {
    const lines = arrange(frame, settings, 50)

    for (const line of lines) expect(lineWidth(line) <= 50).toBe(true)

    const text = lines.map(plain).join('\n')

    expect(text).toContain('Sonnet 5.5')
    expect(text).toContain('34%')
    expect(text).toContain('7d')
    expect(text).not.toContain('left')
    expect(text).not.toContain('(2h13m)')
  })

  test('each line takes the richest detail it has room for', () => {
    const dir = 'a-really-long-project-directory-name'
    const long: Frame = {
      ...frame,
      identity: { ...frame.identity, dir, sessionName: `${dir}-a4` },
    }
    const [context = [], metrics = []] = arrange(long, settings, 70)

    // The first line is squeezed to its minimum, but that costs the second nothing.
    expect(plain(context)).not.toContain('▆')
    expect(plain(metrics)).toContain('━')
    expect(plain(metrics)).toContain('57K')
  })

  test('a very narrow one sheds the least wanted first', () => {
    const lines = arrange({ ...frame, git: null }, { ...settings, showCost: true }, 22)
    const [context = [], metrics = []] = lines

    // The metrics shed what they can; the model and the place are never shed.
    expect(lineWidth(metrics) <= 22).toBe(true)

    expect(plain(context)).toContain('Sonnet 5.5')
    expect(plain(context)).toContain('my-project-a4')
    expect(plain(metrics)).toContain('fuel')
    expect(plain(metrics)).toContain('5h')
    expect(plain(metrics)).not.toContain('7d')
    expect(plain(metrics)).not.toContain('$0.42')
  })

  test('a window past its reset is dimmed and marked, with no countdown', () => {
    const stale: Frame = {
      ...frame,
      usage: {
        ...usage,
        windows: {
          five_hour: { percentUsed: 20, resetsAt: '2026-10-13T11:00:00Z' },
          seven_day: usage.windows.seven_day,
        },
      },
    }
    const lines = arrange(stale, settings, 200)
    const text = lines.map(plain).join('\n')
    const part = lines
      .flat()
      .flatMap(seg => seg.parts)
      .find(one => one.text === '~20%')

    expect(text).toContain('~20%')
    expect(part?.dim).toBe(true)
    expect(text).toContain('(3d4h)')
    expect(text).not.toContain('~20% (')
  })

  test('before the first response the gauge holds its place with a dash', () => {
    const fresh: Frame = {
      ...frame,
      usage: { ...usage, tokens: null, windows: { five_hour: null, seven_day: null } },
    }
    const text = arrange(fresh, settings, 200).map(plain).join('\n')

    expect(text).toContain('fuel')
    expect(text).toContain('–')
    expect(text).not.toContain('5h')
  })

  test('a renamed session shows the directory and a tag', () => {
    const renamed: Frame = {
      ...frame,
      identity: { ...frame.identity, sessionName: 'fuel-gauge-fix' },
    }
    const text = arrange(renamed, settings, 200).map(plain).join('\n')

    expect(text).toContain('my-project · @fuel-gauge-fix')
  })

  test('a dirty tree shows its counts, signed', () => {
    const dirty: Frame = {
      ...frame,
      git: { ...git, staged: 1, modified: 3, untracked: 2, ahead: 1 },
    }
    const text = arrange(dirty, settings, 200).map(plain).join('\n')

    expect(text).toContain('main +1 ~3 ?2 ↑1')
  })

  test('emoji icons give the original look', () => {
    const text = arrange(frame, { ...settings, icons: 'emoji' }, 200)
      .map(plain)
      .join('\n')

    expect(text).toContain('🤖')
    expect(text).toContain('📁')
    expect(text).toContain('🌿')
    expect(text).toContain('⛽')
    expect(text).toContain('📊')
  })

  test('under 30% the label turns red; the emoji style keeps its warning icon', () => {
    const low: Frame = { ...frame, usage: { ...usage, tokens: 160_000 } }
    const label = arrange(low, settings, 200)
      .flat()
      .find(seg => seg.id === 'fuel')?.parts[0]

    expect(label).toEqual({ text: 'fuel ', color: 'error' })
    expect(arrange(low, { ...settings, icons: 'emoji' }, 200).map(plain).join('\n')).toContain('⚠️')
  })

  test('glyphs are ones every coding font has: no fallback, no width surprises', () => {
    const text = arrange(frame, settings, 200).map(plain).join('\n')

    for (const glyph of ['↻', '⎇', '⧉', '⚠']) expect(text).not.toContain(glyph)
  })
})

describe('effort', () => {
  const settings: Settings = { layout: 'auto', icons: 'symbols', showCost: false }
  const base: Frame = {
    identity: {
      model: 'Sonnet 5.5',
      effort: 'xhigh',
      dir: 'proj',
      cwd: '/w/proj',
      sessionName: null,
    },
    git: null,
    usage: {
      tokens: 110_000,
      window: 200_000,
      isAutoCompact: true,
      compactAt: null,
      parts: [],
      history: [],
      costUsd: null,
      windows: { five_hour: null, seven_day: null },
    },
    now: Date.parse('2026-10-13T12:00:00Z'),
    isWorking: false,
  }
  const first = (frame: Frame, icons: Settings['icons'], columns = 200) =>
    plain(arrange(frame, { ...settings, icons }, columns)[0] ?? [])

  test('sits beside the model, on a five-bar meter lit to the level', () => {
    expect(first(base, 'symbols')).toContain('Sonnet 5.5 ▁▂▄▆█ xhigh')
    expect(effortStyle('low')).toEqual({ lit: '▁', unlit: '▂▄▆█', rank: 1 })
    expect(effortStyle('high')).toEqual({ lit: '▁▂▄', unlit: '▆█', rank: 3 })
    expect(effortStyle('max')).toEqual({ lit: '▁▂▄▆█', unlit: '', rank: 5 })
  })

  test('the lit bars carry the accent, the rest stay dark', () => {
    const parts = arrange(base, settings, 200)[0]?.find(seg => seg.id === 'model')?.parts ?? []

    expect(parts.find(part => part.text === '▁▂▄▆')?.color).toBe('claude')
    expect(parts.find(part => part.text === '█')?.color).toBe('subtle')
  })

  test('the emoji style has its own mark', () => {
    expect(first(base, 'emoji')).toContain('🧠 xhigh')
  })

  test('a model without effort shows none', () => {
    const none: Frame = { ...base, identity: { ...base.identity, effort: null } }

    expect(first(none, 'symbols')).not.toContain('xhigh')
    expect(first(none, 'symbols')).toContain('Sonnet 5.5')
  })

  test('a level the build does not know is shown as it is, with no block', () => {
    const odd: Frame = { ...base, identity: { ...base.identity, effort: 'ultra' } }

    expect(first(odd, 'symbols')).toContain('Sonnet 5.5 ultra')
  })

  test('a narrow band keeps the word and gives up the block', () => {
    const lines = arrange(base, settings, 24)
    const text = plain(lines[0] ?? [])

    expect(text).toContain('xhigh')
    expect(text).not.toContain('▆')
  })
})

describe('chips and the way out', () => {
  const settings: Settings = { layout: 'auto', icons: 'symbols', showCost: false }
  const frame: Frame = {
    identity: {
      model: 'claude-sonnet-5-5',
      effort: 'high',
      dir: 'proj',
      cwd: '/w/proj',
      sessionName: null,
    },
    git: null,
    usage: {
      tokens: 160_000,
      window: 200_000,
      isAutoCompact: true,
      compactAt: null,
      parts: [],
      history: [],
      costUsd: null,
      windows: { five_hour: null, seven_day: null },
    },
    now: Date.parse('2026-10-13T12:00:00Z'),
    isWorking: false,
  }
  const parts = (value: Frame, options: Settings = settings, columns = 200) =>
    arrange(value, options, columns)
      .flat()
      .flatMap(seg => seg.parts)

  test('chips are kept for alarms: the model is plain accented text', () => {
    const calm = { ...frame, usage: { ...frame.usage, tokens: 20_000 } }
    const name = parts(calm).find(part => part.text === 'Sonnet 5.5')

    expect(name?.color).toBe('claude')
    expect(name?.bold).toBe(true)
    expect(parts(calm).some(part => part.bg !== undefined)).toBe(false)
    expect(parts(frame, { ...settings, icons: 'emoji' }).some(part => part.bg !== undefined)).toBe(false)
  })

  test('low fuel lights the number and offers /compact', () => {
    const list = parts(frame)

    expect(list.find(part => part.text === ' 4% ')?.bg).toBe('error')
    expect(list.find(part => part.text === '/compact')?.press).toBe('compact')
  })

  test('nothing is offered while a turn runs, or when fuel is fine', () => {
    expect(parts({ ...frame, isWorking: true }).some(part => part.press !== undefined)).toBe(false)
    expect(
      parts({ ...frame, usage: { ...frame.usage, tokens: 20_000 } }).some(
        part => part.press !== undefined,
      ),
    ).toBe(false)
  })

  test('a very narrow band has no room for it', () => {
    expect(parts(frame, settings, 20).some(part => part.press !== undefined)).toBe(false)
  })
})

describe('click to copy', () => {
  const settings: Settings = { layout: 'auto', icons: 'symbols', showCost: false }
  const frame: Frame = {
    identity: {
      model: 'claude-sonnet-5-5',
      effort: 'high',
      dir: 'my-project',
      cwd: '/home/me/Work/my-project',
      sessionName: 'my-project-a4',
    },
    git: {
      branch: 'feat/x',
      isDetached: false,
      staged: 0,
      modified: 1,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0,
    },
    usage: {
      tokens: 20_000,
      window: 200_000,
      isAutoCompact: true,
      compactAt: null,
      parts: [],
      history: [],
      costUsd: null,
      windows: { five_hour: null, seven_day: null },
    },
    now: Date.parse('2026-10-13T12:00:00Z'),
    isWorking: false,
  }
  const copies = (value: Frame) =>
    arrange(value, settings, 200)
      .flatMap((line: Seg[]) => line.flatMap(seg => chunkParts(seg.parts)))
      .flatMap(chunk => (chunk.copy === undefined ? [] : [chunk.copy]))

  test('the model, the place, the branch', () => {
    expect(copies(frame)).toEqual([
      { id: 'model', text: 'claude-sonnet-5-5' },
      { id: 'place', text: 'my-project-a4' },
      { id: 'branch', text: 'feat/x' },
    ])
  })

  test('a directory copies its whole path, a name copies as shown', () => {
    const plainDir: Frame = {
      ...frame,
      identity: { ...frame.identity, sessionName: null },
    }
    const renamed: Frame = {
      ...frame,
      identity: { ...frame.identity, sessionName: 'fuel-gauge-fix' },
    }

    expect(copies(plainDir).find(one => one.id === 'place')?.text).toBe(
      '/home/me/Work/my-project',
    )
    expect(copies(renamed).find(one => one.id === 'place')?.text).toBe(
      '/home/me/Work/my-project',
    )
    expect(copies(renamed).find(one => one.id === 'tag')?.text).toBe('fuel-gauge-fix')
  })

  test('a glyph and its name are one target', () => {
    const renamed: Frame = {
      ...frame,
      identity: { ...frame.identity, sessionName: 'fuel-gauge-fix' },
    }
    const tag = arrange(renamed, settings, 200)
      .flatMap((line: Seg[]) => line.flatMap(seg => chunkParts(seg.parts)))
      .find(chunk => chunk.copy?.id === 'tag')

    expect(tag?.parts.map(part => part.text)).toEqual(['@', 'fuel-gauge-fix'])
  })

  test('the numbers and bars are not buttons', () => {
    const buttons = arrange(frame, settings, 200)
      .flatMap((line: Seg[]) => line.flatMap(seg => chunkParts(seg.parts)))
      .filter(chunk => chunk.copy !== undefined || chunk.press !== undefined)

    expect(buttons).toHaveLength(3)
  })
})

describe('pace marks and cards', () => {
  const settings: Settings = { layout: 'auto', icons: 'symbols', showCost: false }
  const now = Date.parse('2026-10-13T12:00:00Z')
  const H = 3_600_000
  const at = (ms: number) => new Date(now + ms).toISOString()
  const frame: Frame = {
    identity: {
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      dir: 'proj',
      cwd: '/w/proj',
      sessionName: 'proj-a4',
    },
    git: {
      branch: 'main',
      isDetached: false,
      staged: 1,
      modified: 2,
      untracked: 0,
      conflicted: 1,
      ahead: 0,
      behind: 2,
    },
    usage: {
      tokens: 96_400,
      window: 200_000,
      isAutoCompact: true,
      compactAt: 167_000,
      parts: [
        { name: 'Messages', tokens: 61_400, color: 'claude' },
        { name: 'System tools', tokens: 17_900, color: 'inactive' },
      ],
      history: [72_000, 84_100, 96_400],
      costUsd: null,
      windows: {
        // 3h of 5h gone with 86% used: on pace to run out.
        five_hour: { percentUsed: 86, resetsAt: at(2 * H) },
        // A day and a half of seven gone with 10% used: behind the clock.
        seven_day: { percentUsed: 10, resetsAt: at(132 * H) },
      },
    },
    now,
    isWorking: false,
  }
  const seg = (id: string) => build(frame, settings, 0).find(one => one.id === id)
  const text = (rows: readonly Part[][] = []) =>
    rows.map(row => row.map(part => part.text).join('')).join('\n')

  test('a window`s bar carries a mark at where an even pace would be', () => {
    const marks = (seg('seven_day')?.parts ?? []).filter(part => part.text === '│')

    expect(marks).toHaveLength(1)
    expect(marks[0]?.color).toBe('inactive')
  })

  test('the mark lights up when the pace held would run the window out', () => {
    const mark = (seg('five_hour')?.parts ?? []).find(part => part.text === '┃' || part.text === '│')

    expect(mark?.color).toBe('warning')
  })

  test('the emoji style keeps its plain bars', () => {
    const parts = build(frame, { ...settings, icons: 'emoji' }, 0).flatMap(one => one.parts)

    expect(parts.some(part => part.text === '│' || part.text === '┃')).toBe(false)
  })

  test('the fuel card says how much is left, what fills it, and how fast it goes', () => {
    const card = seg('fuel')?.card

    expect(card?.title).toBe('Context · 42% left')
    expect(text(card?.rows)).toContain('70.6K of 167K left before auto-compact')
    expect(text(card?.rows)).toContain('Messages 61.4K')
    expect(text(card?.rows)).toContain('last turn +12.3K · room for ~5 more like it')
  })

  test('the window card calls the pace and when it resets', () => {
    const hot = text(seg('five_hour')?.card?.rows)
    const calm = text(seg('seven_day')?.card?.rows)

    expect(hot).toContain('86% used · 60% of the window gone')
    // 14% more at 86% per 3h is 29 minutes, with two hours to go.
    expect(hot).toContain('at this pace it runs out in 29m, 1h30m before the reset')
    expect(hot).toContain('resets in 2h00m')
    expect(calm).toContain('at this pace: ~47% by the reset')
  })

  test('the git card spells the counts out', () => {
    const card = seg('git')?.card

    expect(text(card?.rows)).toContain('1 conflicted · 1 staged · 2 modified')
    expect(text(card?.rows)).toContain('2 commits to pull')
    expect(text(card?.rows)).toContain('click to copy the branch')
  })

  test('the name card says what the name is for', () => {
    expect(text(seg('place')?.card?.rows)).toContain('other sessions message this one by this name')
    expect(text(seg('model')?.card?.rows)).toContain('claude-opus-5-5')
  })

  test('before the first reply the fuel card says when it fills in', () => {
    const fresh: Frame = { ...frame, usage: { ...frame.usage, tokens: null } }
    const card = build(fresh, settings, 0).find(one => one.id === 'fuel')?.card

    expect(text(card?.rows)).toContain('fills in after the first reply')
  })
})

describe('the tree', () => {
  const settings: Settings = { layout: 'auto', icons: 'symbols', showCost: false }
  const frame: Frame = {
    identity: { model: 'claude-opus-5-5', effort: 'high', dir: 'proj', cwd: '/w/proj', sessionName: null },
    git: null,
    usage: {
      tokens: 50_000,
      window: 200_000,
      isAutoCompact: true,
      compactAt: null,
      parts: [],
      history: [],
      costUsd: null,
      windows: { five_hour: null, seven_day: null },
    },
    now: Date.parse('2026-10-13T12:00:00Z'),
    isWorking: false,
  }
  type Node = { type: string; props: Record<string, unknown> }
  const el = (type: string) => (props: object) => ({ type, props }) as never
  const els = { Box: el('Box'), Text: el('Text'), Button: el('Button') }
  const actions = { copy: () => () => {}, compact: () => {} }
  const walk = (node: Node, out: Node[] = []): Node[] => {
    out.push(node)
    const children = node.props.children
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === 'object' && child !== null) walk(child as Node, out)
    }
    return out
  }
  const tree = (hasCards: boolean) =>
    walk(
      view(els, arrange(frame, settings, 100), actions, {
        columns: 100,
        separator: separatorPart(settings),
        hasCards,
      }) as unknown as Node,
    )

  test('each segment is a keyed box, its card hidden until the pointer rests on it', () => {
    const nodes = tree(true)
    const cards = nodes.filter(node => node.props.position === 'absolute')

    expect(nodes.some(node => node.props.key === 'seg:model')).toBe(true)
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.props.display).toBe('none')
      expect(card.props.hover).toEqual({ display: 'flex' })
    }
  })

  test('no cards when they are switched off', () => {
    expect(tree(false).some(node => node.props.position === 'absolute')).toBe(false)
  })

  test('a card stays inside the band', () => {
    expect(cardLeft(10, 30, 100)).toBe(0)
    expect(cardLeft(90, 30, 100)).toBe(-20)
    // Wider than the band: pinned to its left edge.
    expect(cardLeft(5, 200, 100)).toBe(-5)
  })

  test('a card is as wide as its widest row, inside its border', () => {
    const size = cardSize({ title: 'abc', rows: [[{ text: 'abcdefgh' }]] }, 100)

    expect(size).toEqual({ width: 12, height: 4, inner: 8 })
  })
})

describe('the band', () => {
  const NAME = 'byj-statusline'
  const props = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  }

  // Beneath the plugins the engine draws its own band: here, an empty one.
  const engineBand = (on: On) =>
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)

      return Box({})
    })

  test('draws on the terminal and the desktop', async ($, on) => {
    mock.clock(on)
    engineBand(on)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'byj-statusline',
        surface,
        component: 'AbovePrompt',
        props,
      })

      // Nothing has been measured yet, so the gauge holds its place.
      expect(await ui.find({ type: 'Text', text: /fuel/ })).toBeDefined()
      // The surface's own table accepts the tree, hover cards and all.
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect(await ui.find({ type: 'Box', key: 'seg:fuel' })).toBeDefined()

      await ui.unmount()
    }
  })

  // The band reads state only its own hooks write, so the test plays the engine:
  // it answers what the plugin asks, and a prompt wakes the plugin to ask.
  async function wake($: Engine, on: On, clock: MockClock) {
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.cwd', () => ({ value: '/w/proj' }))
    on('session.id', () => ({ value: 'sid-1' }))
    on('settings.read', () => ({ value: { modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'high' } } } }))
    on('env.get', () => ({ value: '/home/me' }))
    on('fs.list', () => ({
      value: [{ name: '1.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }],
    }))
    on('fs.read', () => ({
      value: JSON.stringify({ sessionId: 'sid-1', name: 'proj-a4', updatedAt: 1 }),
    }))
    on('config.list', () => ({ value: [] }))
    on('store.get', () => ({ value: undefined }))
    on('process.run', () => ({
      value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    await clock.advance(100)
  }

  test('shows who the session is, with the effort beside the model', async ($, on) => {
    const clock = mock.clock(on)
    engineBand(on)

    await wake($, on, clock)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)

    expect(texts).toContain('Sonnet 5.5')
    expect(texts).toContain('high')
    expect(texts).toContain('proj-a4')
    expect(texts).not.toContain('')

    await ui.unmount()
  })

  test('a click on a name copies it, and says so', async ($, on) => {
    const clock = mock.clock(on)
    engineBand(on)
    const copied: string[] = []
    const toasts: string[] = []

    on('ui.copy', (_, e) => {
      copied.push(e.text)

      return { value: { isCopied: true as const } }
    })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })

    await wake($, on, clock)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: NAME, surface, component: 'AbovePrompt', props })

      expect(await ui.find({ type: 'Button', key: 'copy:place' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'copy:model' })).toBeDefined()

      await ui.press({ key: 'copy:place' })
      await ui.press({ key: 'copy:model' })
      await ui.unmount()
    }

    expect(copied).toEqual(['proj-a4', 'claude-sonnet-5-5', 'proj-a4', 'claude-sonnet-5-5'])
    expect(toasts[0]).toBe('Copied proj-a4')
    expect(toasts[1]).toBe('Copied claude-sonnet-5-5')
  })
})
