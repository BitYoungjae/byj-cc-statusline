// byj-statusline: a status band above the prompt.
//
// This file gathers the figures and hands them to the drawing; everything it
// draws is decided in `lib/`, which never touches `$`. The engine is asked
// (`$.session.usage()`, `$.session.model()`) and says when a figure moves
// (`session.measure`, `turn.step`, `session.compact`), so nothing is parsed and
// no transcript is read. `$.store` keeps the rate limits across sessions.
//
// `$` is only ever passed to functions declared at the top of this file, which
// is why the helpers live out here and not inside `register`.

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  RenderSurface,
  SessionContextBreakdown,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { ContextPart, GitInfo, Identity, Usage, WindowReading } from '../types'
import { arrange } from './lib/arrange'
import { WINDOW_SPAN_MS } from './lib/cards'
import { baseName, countdown, fuel, pace } from './lib/format'
import { GIT_STATUS_ARGV, parseGitStatus } from './lib/git'
import { parseEntry, pickName, registryFiles } from './lib/session-name'
import { effortSetting } from './lib/settings'
import { separatorPart, type Settings } from './lib/style'
import { view } from './lib/view'

const TICK_MS = 30_000
/** Tool calls come in bursts; git is asked at most this often for them. */
const GIT_QUIET_MS = 1_500
const STORE_KEY = 'rate-limits'
/** The tools that can change what `git status` says. */
const MAY_TOUCH_FILES = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Turns of fill kept for the growth figures. */
const HISTORY = 12

const identity = atom(
  { plugin: 'byj-statusline', key: 'identity' } as const,
  { model: '', effort: null, dir: '', cwd: '', sessionName: null },
)
const git = atom({ plugin: 'byj-statusline', key: 'git' } as const, null)
const usage = atom(
  { plugin: 'byj-statusline', key: 'usage' } as const,
  {
    tokens: null,
    window: 0,
    isAutoCompact: true,
    compactAt: null,
    parts: [],
    history: [],
    costUsd: null,
    windows: { five_hour: null, seven_day: null },
  },
)
const clock = atom({ plugin: 'byj-statusline', key: 'now' } as const, 0)

type Options = Settings & { hasCards: boolean }

// What the module knows between events. A reload starts these over, and
// `session.start` fires again to fill them.
let settings: Options = { layout: 'auto', icons: 'symbols', showCost: false, hasCards: true }
let hasAlerts = true

// The last reading of each window. Merged per window, never replaced: Claude
// Code drops a window the moment it resets, and the gauge should keep showing
// the last value, dimmed, until the next response brings the new one.
let windows: Usage['windows'] = { five_hour: null, seven_day: null }
let isAutoCompact = true

// The context as last measured. `session.measure` waits for a turn to end,
// so a long turn's own requests (`turn.step`) move the fill in between, and a
// compaction sets it at once.
let figures: Usage | null = null
let compactAt: number | null = null
let parts: ContextPart[] = []
let history: number[] = []

// How hard the model is asked to think. The truth is what the last request
// carried (`turn.step`); until there is one, and when the person changes it
// between requests, it is what the settings say.
let effort: string | null = null
let savedEffort: string | null | undefined
let lastIdentity: Identity | null = null

let timer: Timer | null = null
let beginning: Promise<void> | null = null
let isGitBusy = false
let isGitQueued = false
let isGitScheduled = false
let lastFuelLevel: string | null = null
const warned = new Set<string>()
const written = new Map<string, string>()

function settingsOf(options: PluginOptions): Options {
  return {
    layout: options.layout === 'two-line' ? 'two-line' : 'auto',
    icons: options.icons === 'emoji' ? 'emoji' : 'symbols',
    showCost: options.showCost === true,
    hasCards: options.details !== false,
  }
}

function toReading(raw: unknown): WindowReading | null {
  if (typeof raw !== 'object' || raw === null) return null

  const { percentUsed, resetsAt } = raw as Record<string, unknown>

  if (typeof percentUsed !== 'number') return null

  return {
    percentUsed,
    resetsAt: typeof resetsAt === 'string' ? resetsAt : null,
  }
}

/** What `$.store` kept from an earlier session, or nothing when it is not the shape written. */
function toWindows(raw: unknown): Usage["windows"] {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >

  return {
    five_hour: toReading(stored.five_hour),
    seven_day: toReading(stored.seven_day),
  }
}

/** Writes a value only when it differs from the last one written: a redraw per no-op would add up. */
async function sync<T>(key: string, value: T, write: (value: T) => Promise<unknown>) {
  const json = JSON.stringify(value)

  if (written.get(key) === json) return

  written.set(key, json)
  await write(value)
}

// ── identity: model, directory, messaging name ──

async function findSessionName($: EngineInterface, sessionId: string) {
  try {
    const configDir =
      (await $.env.get('CLAUDE_CONFIG_DIR')) ??
      `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''}/.claude`
    const dir = `${configDir}/sessions`
    const files = registryFiles(await $.fs.list(dir))

    // One file at a time, so one cut off mid-write costs only itself.
    const entries = await Promise.all(
      files.map(async file => {
        try {
          return parseEntry(await $.fs.read(`${dir}/${file}`))
        } catch {
          return null
        }
      }),
    )

    return pickName(entries, sessionId)
  } catch {
    return null
  }
}

async function publishIdentity($: EngineInterface, next: Identity) {
  lastIdentity = next

  await sync('identity', next, value => update($, identity, () => value))
}

/**
 * The effort the settings hold for the model. A change since the last read is
 * the person switching it (`/effort`, `/model`), so it takes over at once
 * instead of waiting for the next request to confirm it.
 */
function noteEffortSetting(value: string | null) {
  if (value === savedEffort) return

  savedEffort = value
  effort = value
}

/** What a request of the main thread carried: the level it truly ran at, or none for a model without effort. */
async function noteEffort($: EngineInterface, level: string | number | undefined) {
  const next = level === undefined ? null : String(level)

  if (next === effort) return

  effort = next

  // Before the first identity is read there is nothing to amend: the read picks it up.
  if (lastIdentity !== null) {
    await publishIdentity($, { ...lastIdentity, effort })
  }
}

async function refreshIdentity($: EngineInterface) {
  try {
    const [model, cwd, sessionId, saved] = await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.id(),
      $.settings.read().catch(() => null),
    ])
    const sessionName = await findSessionName($, sessionId)

    // Unreadable settings keep what was known.
    if (saved !== null) noteEffortSetting(effortSetting(saved, model))

    await publishIdentity($, { model, effort, dir: baseName(cwd), cwd, sessionName })
  } catch {
    // The band shows what it has.
  }
}

// ── what the band's buttons do ──

/** Puts a value on the clipboard and says so: a copy nobody sees land feels like none. */
async function copyText($: EngineInterface, surface: RenderSurface, text: string) {
  const shown = text.length > 48 ? `${text.slice(0, 47)}…` : text

  try {
    const result = await $.ui.copy({ text, surface })

    $.ui.toast(
      result.isCopied ? `Copied ${shown}` : `Could not copy (${result.reason})`,
      { timeoutMs: 2_000 },
    )
  } catch {
    $.ui.toast('Could not copy.', { timeoutMs: 2_000 })
  }
}

/**
 * Types /compact into the prompt, and stops there. Compacting rewrites the
 * conversation, so it is the person's Enter; and a draft in progress is never
 * written over.
 */
async function offerCompact($: EngineInterface) {
  try {
    const box = await $.prompt.read()

    if (box.text.trim() !== '') {
      $.ui.toast('Finish or clear the prompt, then press again.', { timeoutMs: 3_000 })

      return
    }

    await $.prompt.fill({ text: '/compact', mode: 'replace' })
  } catch {
    // Nothing to fall back on: the button is a shortcut, the command still works typed.
  }
}

// ── git ──

async function refreshGit($: EngineInterface) {
  // One status at a time; a request that arrives meanwhile runs once more after.
  if (isGitBusy) {
    isGitQueued = true

    return
  }

  isGitBusy = true

  try {
    do {
      isGitQueued = false

      let info: GitInfo | null = null

      try {
        const cwd = await $.session.cwd()
        const ran = await $.process.run(GIT_STATUS_ARGV, { cwd, timeoutMs: 5_000 })

        info = ran.exitCode === 0 ? parseGitStatus(ran.stdout) : null
      } catch {
        // Not a repository, or no git: no segment.
      }

      await sync('git', info, value => update($, git, () => value))
    } while (isGitQueued)
  } finally {
    isGitBusy = false
  }
}

/** A burst of tool calls asks once, after it has gone quiet for a moment. */
function scheduleGit($: EngineInterface) {
  if (isGitScheduled) return

  isGitScheduled = true
  $.clock.after(GIT_QUIET_MS, () => {
    isGitScheduled = false
    void refreshGit($)
  })
}

// ── usage: context, rate limits, cost ──

async function raiseAlerts($: EngineInterface, current: Usage) {
  const reading = fuel(current.tokens, current.window, current.isAutoCompact, current.compactAt)

  if (reading !== null) {
    // On the way down only: the first reading is a state, not an event.
    if (reading.level === 'bad' && lastFuelLevel !== null && lastFuelLevel !== 'bad') {
      $.ui.toast(`Fuel is down to ${reading.percent}%: /compact or /clear soon.`)
    }

    lastFuelLevel = reading.level
  }

  const now = await $.clock.now()

  for (const [kind, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const window = current.windows[kind]

    if (window === null) continue

    const resetsAt = window.resetsAt === null ? NaN : Date.parse(window.resetsAt)

    // A remembered reading already past its reset is history, not news.
    if (resetsAt <= now) continue

    const until = Number.isFinite(resetsAt) ? `, resets in ${countdown(resetsAt - now)}` : ''

    if (window.percentUsed >= 90) {
      const key = `${kind}:high:${window.resetsAt}`

      if (!warned.has(key)) {
        warned.add(key)
        $.ui.toast(`${label} usage is at ${Math.round(window.percentUsed)}%${until}.`)
      }

      continue
    }

    // Before the line, the pace: half used and burning fast enough to run
    // out before the reset is worth saying once, while there is time to act.
    const step = pace(window.percentUsed, resetsAt, now, WINDOW_SPAN_MS[kind])
    const key = `${kind}:pace:${window.resetsAt}`

    if (window.percentUsed >= 50 && step !== null && step.runsOutInMs !== null && !warned.has(key)) {
      warned.add(key)
      $.ui.toast(
        `${label} usage is at ${Math.round(window.percentUsed)}%: at this pace it runs out in ${countdown(step.runsOutInMs)}${until}.`,
      )
    }
  }
}

/**
 * Draws what the module knows: the last measurement with the live fill,
 * breakdown and history over it. Never throws: it runs inside hooks that sit
 * on a compaction's or a request's way, and a status must not stand in it.
 */
async function publishUsage($: EngineInterface) {
  if (figures === null) return

  try {
    const current: Usage = { ...figures, isAutoCompact, compactAt, parts, history, windows }

    await sync('usage', current, value => update($, usage, () => value))

    if (hasAlerts) await raiseAlerts($, current)
  } catch {
    // The band keeps what it last drew.
  }
}

async function applyUsage(
  $: EngineInterface,
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
  cost: SessionCost | undefined,
) {
  try {
    // The windows the last session remembered must be loaded before this one merges into them.
    await ensureStarted($)

    const next = { ...windows }

    for (const limit of rateLimits) {
      if (limit.kind !== 'five_hour' && limit.kind !== 'seven_day') continue

      next[limit.kind] = {
        percentUsed: limit.percentUsed,
        resetsAt: limit.resetsAt ?? null,
      }
    }

    if (JSON.stringify(next) !== JSON.stringify(windows)) {
      windows = next
      // So the next session has something to show before its first response.
      $.store.set(STORE_KEY, next).catch(() => {})
    }

    figures = {
      tokens: context.tokens ?? figures?.tokens ?? null,
      window: context.window,
      isAutoCompact,
      compactAt,
      parts,
      history,
      costUsd: cost?.usd ?? null,
      windows,
    }

    await publishUsage($)
  } catch {
    // A figure that cannot be read leaves the last one on screen.
  }
}

/** The rows of the context, largest first, and the point the engine compacts at. */
function readBreakdown(breakdown: SessionContextBreakdown | undefined) {
  if (breakdown === undefined) return

  isAutoCompact = breakdown.isAutoCompactEnabled
  compactAt = breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null
  parts = breakdown.categories
    .filter(row => row.kind === 'used' && row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(row => ({ name: row.name, tokens: row.tokens, color: row.color }))
}

/**
 * The breakdown /context draws, counted from the last response and local
 * estimates (`summary`): no request is made for it.
 */
async function refreshBreakdown($: EngineInterface) {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })

    readBreakdown(context.breakdown)
    await publishUsage($)
  } catch {
    // The gauge falls back on the fixed buffer.
  }
}

async function refreshUsage($: EngineInterface) {
  try {
    const current = await $.session.usage({ breakdown: 'summary' })

    readBreakdown(current.context.breakdown)
    await applyUsage($, current.context, current.rateLimits, current.cost)
  } catch {
    // As above.
  }
}

/** A request of the main loop came back: its input is the context's fill, now. */
async function noteFill($: EngineInterface, tokens: number) {
  if (figures === null || tokens <= 0) return

  figures = { ...figures, tokens }
  await publishUsage($)
}

/** A main-loop turn ended: the fill it ended at joins the history. */
async function noteTurnEnd($: EngineInterface) {
  const tokens = figures?.tokens ?? null

  if (tokens === null || history[history.length - 1] === tokens) return

  history = [...history, tokens].slice(-HISTORY)
  await publishUsage($)
}

async function tick($: EngineInterface) {
  await sync('now', await $.clock.now(), value => update($, clock, () => value))
  void refreshGit($)
  // Catches /config turning auto-compact off or on between replies.
  void refreshBreakdown($)
  await refreshIdentity($)
}

async function begin($: EngineInterface) {
  // The first prompt waits on `session.start`, so this waits on the store
  // alone: git and the disk are read in the background.
  windows = toWindows(await $.store.get(STORE_KEY).catch(() => undefined))

  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => {
    void tick($)
  })

  void Promise.all([tick($), refreshUsage($)])
}

/**
 * Starts the band once. `session.start` is the usual way in, but a /clear ends
 * the session without starting another, and a mod switched on mid-session never
 * saw a start, so the first event of any kind gets it going too.
 */
function ensureStarted($: EngineInterface): Promise<void> {
  beginning ??= begin($)

  return beginning
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)
  hasAlerts = options.alerts !== false

  // ── events ──

  on('session.start', async ($, e, next) => {
    await ensureStarted($)

    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = null
    beginning = null
    // A /clear ends the session: the next one's context starts from nothing.
    figures = null
    history = []
    lastFuelLevel = null

    return next(e)
  })

  // The engine says when a figure moves: after each turn, and when a window
  // moves a whole point.
  on('session.measure', async ($, e, next) => {
    await applyUsage($, e.context, e.rateLimits, e.cost)

    // The mix and the compaction point move with the fill; counted locally.
    if (e.changed.includes('context')) void refreshBreakdown($)

    return next(e)
  })

  // A compaction sets the fill at once; the next measurement waits for a response.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (
      e.agentId === undefined &&
      e.trigger !== 'precompute' &&
      result.skip === undefined &&
      result.tokensAfter !== undefined
    ) {
      await noteFill($, result.tokensAfter)
      await noteTurnEnd($)
      void refreshBreakdown($)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await ensureStarted($)
    void refreshGit($)
    void refreshIdentity($)

    if (e.agentId === undefined) await noteTurnEnd($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($)
    void refreshIdentity($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A model request: the one place that says what effort it runs at, and,
  // once it is back, what the context holds mid-turn. Observed, forwarded untouched.
  on('turn.step', async function* ($, e, next) {
    // Only the main thread's own requests: a subagent runs at an effort and a context of its own.
    if (e.agentId === undefined) void noteEffort($, e.effort)

    const result = yield* next(e)
    const spent = result.usage

    if (e.agentId === undefined && spent !== null) {
      await noteFill(
        $,
        spent.input_tokens + spent.cache_read_input_tokens + spent.cache_creation_input_tokens,
      )
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (MAY_TOUCH_FILES.has(String(e.tool))) scheduleGit($)

    return ran
  }).catch(($, e, next) => next(e))

  // ── drawing ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever other plugins drew stays, above this band.
    const below = await next(e)

    // A survey has the band; the status waits.
    if (e.props.hasSurvey) return below

    const [who, repo, current, ticked] = await Promise.all([
      read($, identity),
      read($, git),
      read($, usage),
      read($, clock),
    ])
    const now = ticked > 0 ? ticked : await $.clock.now()
    // One cell of margin on the left, so the band lines up with the prompt's text.
    const columns = Math.max(1, e.props.bodyColumns - 1)
    const lines = arrange(
      { identity: who, git: repo, usage: current, now, isWorking: e.props.isWorking },
      settings,
      columns,
    )

    if (lines.length === 0) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const band = view(
      { Box, Button, Text },
      lines,
      {
        copy: text => press => copyText($, press.surface, text),
        compact: () => offerCompact($),
      },
      { columns, separator: separatorPart(settings), hasCards: settings.hasCards },
    )

    return (
      <Box flexDirection="column">
        {below}
        {band}
      </Box>
    )
  })
}
