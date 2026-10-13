import { describe, expect, test } from 'claude-code/testing'

import {
  ago,
  baseName,
  clip,
  countdown,
  effortStyle,
  elapsed,
  fuel,
  pace,
  pad,
  padEnd,
  prettyModel,
  safeLimit,
  timeLeft,
  tokens,
  tokensFine,
  turnsLeft,
  usageLevel,
  width,
} from '../hooks/lib/format'
import { isClean, parseGitStatus } from '../hooks/lib/git'
import { parseEntry, pickName, placeName, registryFiles } from '../hooks/lib/session-name'
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

  test('the engine`s compaction point stands in for the fixed buffer once it has said where it is', () => {
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

describe('numbers and clocks', () => {
  test('tokens read as K above a thousand', () => {
    expect(tokens(57_000)).toBe('57K')
    expect(tokens(900)).toBe('900')
  })

  test('fine token counts keep a decimal while it says something', () => {
    expect(tokensFine(12_400)).toBe('12.4K')
    expect(tokensFine(57_000)).toBe('57K')
    expect(tokensFine(167_000)).toBe('167K')
    expect(tokensFine(1_250_000)).toBe('1.3M')
    expect(tokensFine(900)).toBe('900')
  })

  test('countdowns are as short as they read', () => {
    expect(countdown(45 * 60_000)).toBe('45m')
    expect(countdown((2 * 60 + 13) * 60_000)).toBe('2h13m')
    expect(countdown((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
    expect(countdown(1_000)).toBe('1m')
  })

  test('a running clock reads minutes and seconds, then hours', () => {
    expect(elapsed(7_000)).toBe('0:07')
    expect(elapsed(12 * 60_000 + 5_000)).toBe('12:05')
    expect(elapsed(62 * 60_000)).toBe('1h02m')
    expect(elapsed(-5)).toBe('0:00')
  })

  test('time left reads whole minutes from ten, seconds below, nothing once out', () => {
    expect(timeLeft(52 * 60_000)).toBe('52m')
    expect(timeLeft(9 * 60_000 + 42_000)).toBe('9:42')
    expect(timeLeft(45_000)).toBe('0:45')
    // A part of a second left still shows as one.
    expect(timeLeft(200)).toBe('0:01')
    expect(timeLeft(0)).toBeNull()
  })

  test('how long ago, in the fewest words', () => {
    expect(ago(20_000)).toBe('just now')
    expect(ago(4 * 60_000)).toBe('4m ago')
  })

  test('padding counts cells, not characters', () => {
    expect(pad('45m', 5)).toBe('  45m')
    expect(padEnd('45m', 5)).toBe('45m  ')
    expect(padEnd('프로', 5)).toBe('프로 ')
    expect(pad('toolong', 3)).toBe('toolong')
  })
})

describe('text', () => {
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

  test('a long name loses its middle, where names are least distinct', () => {
    expect(clip('feature/fuel-gauge-for-the-statusline', 16)).toBe('feature/…tusline')
    expect(width(clip('feature/fuel-gauge-for-the-statusline', 16))).toBe(16)
    expect(clip('main', 16)).toBe('main')
  })

  test('effort is a five-bar meter lit to its level; an unknown level has none', () => {
    expect(effortStyle('xhigh')).toEqual({ lit: '▁▂▄▆', unlit: '█', rank: 4 })
    expect(effortStyle('max').rank).toBe(5)
    expect(effortStyle('turbo')).toEqual({ lit: '', unlit: '', rank: 0 })
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
    const detached = parseGitStatus('# branch.oid 0aab063c1d2e3f4\n# branch.head (detached)\n')

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
    expect(placeName('my-project', 'my-project-a4')).toEqual({ place: 'my-project-a4', tag: null })
    expect(placeName('my-project', 'my-project')).toEqual({ place: 'my-project', tag: null })
  })

  test('a renamed session keeps the directory and gets a tag', () => {
    expect(placeName('my-project', 'fuel-gauge-fix')).toEqual({ place: 'my-project', tag: 'fuel-gauge-fix' })
  })

  test('a directory that only starts the same is not covered', () => {
    expect(placeName('app', 'application-3')).toEqual({ place: 'app', tag: 'application-3' })
  })

  test('no name leaves the directory alone', () => {
    expect(placeName('my-project', null)).toEqual({ place: 'my-project', tag: null })
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
    const entries = [parseEntry('{"sessionId":"s1","na'), parseEntry(entry('s1', 'still-found', 5))]

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
