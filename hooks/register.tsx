// byj-statusline: a status band above the prompt.
//
// This file gathers the figures and hands them to the drawing; everything it
// draws is decided in `lib/`, which never touches `$`. The engine is asked
// (`$.session.usage()`, `$.session.model()`) and says when a figure moves
// (`session.measure`, `turn.step`, `session.compact`), and what the session
// is doing (`turn.start`, `tool.call`, `agent.spawn`, `turn.complete`), so
// nothing is parsed and no transcript is read. `$.store` keeps the rate
// limits and the cache's TTL across sessions.
//
// `$` is only ever passed to functions declared at the top of this file, which
// is why the helpers live out here and not inside `register`.

import { atom, read, update } from 'claude-code'
import type {
  ClientProps,
  ElementConstructor,
  EngineInterface,
  PluginOptions,
  Register,
  RenderElement,
  RenderSurface,
  SessionContextBreakdown,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
  Timer,
  TurnUsage,
} from 'claude-code'

import type { Activity, CacheState, ContextPart, GitInfo, Identity, TurnReceipt, Usage, WindowReading } from '../types'
import type { ClockProps } from './live/clock'
import {
  agentStatusOf,
  agentTool,
  createTask,
  describeTool,
  EDIT_TOOLS,
  EMPTY_ACTIVITY,
  endTurn,
  finishAgent,
  finishTool,
  phrase,
  pruneAgents,
  receiptOf,
  spawnAgent,
  startTool,
  startTurn,
  todoList,
  updateTask,
  AGENT_LINGER_MS,
} from './lib/activity'
import { arrange } from './lib/arrange'
import {
  EMPTY_CACHE,
  hitRatioOf,
  learnTtl,
  toTtl,
  TRANSCRIPT_TAIL_BYTES,
  TTL_1H,
  TTL_5M,
  ttlOfTranscript,
} from './lib/cache'
import { WINDOW_SPAN_MS } from './lib/cards'
import { baseName, countdown, fuel, pace } from './lib/format'
import { GIT_STATUS_ARGV, parseGitStatus } from './lib/git'
import { parseEntry, pickName, registryFiles } from './lib/session-name'
import { effortSetting } from './lib/settings'
import { paletteOf, separatorPart, type Live, type Settings } from './lib/style'
import { view } from './lib/view'

const TICK_MS = 30_000
/** Tool calls come in bursts; git is asked at most this often for them. */
const GIT_QUIET_MS = 1_500
/** A burst of tool events draws once: the activity is written at most this often. */
const ACTIVITY_COALESCE_MS = 50
/** What a subagent's own tools change shows only in its card: written at most once a second. */
const AGENT_COALESCE_MS = 1_000
const STORE_KEY = 'rate-limits'
const TTL_KEY = 'cache-ttl'
/** The tools that can change what `git status` says. */
const MAY_TOUCH_FILES = new Set(['Bash', ...EDIT_TOOLS])
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
const doing = atom({ plugin: 'byj-statusline', key: 'activity' } as const, EMPTY_ACTIVITY)
const cached = atom({ plugin: 'byj-statusline', key: 'cache' } as const, EMPTY_CACHE)
const clock = atom({ plugin: 'byj-statusline', key: 'now' } as const, 0)

type Options = Settings & { hasCards: boolean }

// What the module knows between events. A reload starts these over, and
// `session.start` fires again to fill them.
let settings: Options = {
  layout: 'auto',
  icons: 'symbols',
  showCost: false,
  hasActivity: true,
  hasCache: true,
  hasCards: true,
}
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
let isEffortRestored = false
let lastIdentity: Identity | null = null

// What the session is doing, and where its running turn started from, for
// the receipt when it ends.
let activity: Activity = EMPTY_ACTIVITY
let turnFrom: { cost: number | null; fill: number | null } = { cost: null, fill: null }
let turnEdits = 0
const scheduled = new Set<number>()

// The main thread's prompt cache: when its last request went out, and how
// long an entry lives (read off the transcript, or learnt, and kept in the
// store). The transcript is read a few times a session at most.
let cache: CacheState = EMPTY_CACHE
let ttlReads = 0
const TTL_READS = 3

// How sure the band is of the TTL. Seen this session (in the transcript, or
// in what the engine says of a resumed cache) outranks learnt from a gap,
// which outranks assumed (the default, or what an earlier session saw).
type TtlSource = 'assumed' | 'learnt' | 'seen'
const TTL_RANK: Record<TtlSource, number> = { assumed: 0, learnt: 1, seen: 2 }
let ttlSource: TtlSource = 'assumed'

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
    hasActivity: options.activity !== false,
    hasCache: options.cache !== false,
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
function toWindows(raw: unknown): Usage['windows'] {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >

  return {
    five_hour: toReading(stored.five_hour),
    seven_day: toReading(stored.seven_day),
  }
}

/**
 * Writes a value only when it differs from the last one written: a redraw per
 * no-op would add up. A write that failed is forgotten, so the next one tries
 * again.
 */
async function sync<T>(key: string, value: T, write: (value: T) => Promise<unknown>) {
  const json = JSON.stringify(value)

  if (written.get(key) === json) return

  written.set(key, json)

  try {
    await write(value)
  } catch (error) {
    if (written.get(key) === json) written.delete(key)

    throw error
  }
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

  try {
    await sync('identity', next, value => update($, identity, () => value))
  } catch {
    // The band shows the identity it had.
  }
}

/**
 * The effort the settings hold for the model. A change since the last read is
 * the person switching it (`/effort`, `/model`), so it takes over at once
 * instead of waiting for the next request to confirm it. Settings that name
 * no level leave the model's default, which only a request can tell.
 */
function noteEffortSetting(value: string | null) {
  if (value === savedEffort) return

  savedEffort = value

  // After a reload the effort shown is the last request's; the first read of the settings changes nothing.
  if (isEffortRestored) {
    isEffortRestored = false

    return
  }

  if (value !== null) effort = value
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

      await sync('git', info, value => update($, git, () => value)).catch(() => {})
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

// ── activity: the turn, its tools, subagents, tasks ──

async function publishActivity($: EngineInterface) {
  try {
    await sync('activity', activity, value => update($, doing, () => value))
  } catch {
    // The band keeps what it last drew.
  }
}

/**
 * Tools come and go in bursts (a dozen reads at once): the line is written
 * once the burst has landed. What only a card shows waits longer.
 */
function scheduleActivity($: EngineInterface, ms = ACTIVITY_COALESCE_MS) {
  if (scheduled.has(ms)) return

  scheduled.add(ms)
  $.clock.after(ms, () => {
    scheduled.delete(ms)
    void publishActivity($)
  })
}

/** What the session has spent so far, as /cost has it; the plain call costs nothing. */
async function spentSoFar($: EngineInterface): Promise<number | null> {
  try {
    return (await $.session.usage()).cost?.usd ?? null
  } catch {
    return null
  }
}

async function beginTurn($: EngineInterface) {
  try {
    const [now, cost] = await Promise.all([$.clock.now(), spentSoFar($)])

    activity = startTurn(activity, now)
    turnFrom = { cost, fill: figures?.tokens ?? null }
    turnEdits = 0
    scheduleActivity($)
  } catch {
    // The line starts with the first tool instead.
  }
}

async function finishTurn($: EngineInterface, durationMs: number, reason: TurnReceipt['reason']) {
  try {
    const [now, cost] = await Promise.all([$.clock.now(), spentSoFar($)])
    const receipt = receiptOf({
      startedAt: now - durationMs,
      endedAt: now,
      tally: activity.tally,
      edits: turnEdits,
      reason,
      cost: { before: turnFrom.cost, after: cost },
      fill: { before: turnFrom.fill, after: figures?.tokens ?? null },
    })

    activity = endTurn(activity, receipt)
    await publishActivity($)
  } catch {
    // The receipt is a nicety; the turn is over either way.
  }
}

type ToolEvent = { tool: unknown; tool_use_id: string; agentId?: string }

/** A tool is about to run: the main loop's joins the running ones, an agent's says what the agent does. */
async function noteToolStart($: EngineInterface, e: ToolEvent) {
  try {
    const tool = String(e.tool)
    const target = describeTool(tool, e as unknown as Record<string, unknown>)

    if (e.agentId === undefined) {
      // The clock first, then the change: a change made across an await would
      // write back over what another hook wrote meanwhile.
      const startedAt = await $.clock.now()

      activity = startTool(activity, { id: e.tool_use_id, tool, target, startedAt })
      scheduleActivity($)
    } else {
      activity = agentTool(activity, e.agentId, phrase(tool, target))
      scheduleActivity($, AGENT_COALESCE_MS)
    }
  } catch {
    // The line misses one tool.
  }
}

/** The task list the main loop keeps, as its tools leave it. */
function noteTasks(tool: string, input: Record<string, unknown>, result: unknown) {
  if (tool === 'TodoWrite') {
    activity = { ...activity, tasks: todoList(input.todos) }
  } else if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: unknown } } | undefined)?.task
    const id = typeof task?.id === 'string' ? task.id : null
    const subject = typeof input.subject === 'string' ? input.subject : ''

    if (id !== null && subject !== '') {
      activity = {
        ...activity,
        tasks: createTask(activity.tasks, id, subject, typeof input.activeForm === 'string' ? input.activeForm : null),
      }
    }
  } else if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    activity = { ...activity, tasks: updateTask(activity.tasks, { ...input, taskId: input.taskId }) }
  }
}

async function noteToolEnd($: EngineInterface, e: ToolEvent, ran: { isError?: boolean; deny?: string; result?: unknown }) {
  try {
    const tool = String(e.tool)
    const isError = ran.isError === true || ran.deny !== undefined

    if (e.agentId === undefined) {
      activity = finishTool(activity, e.tool_use_id, tool, isError)

      if (!isError) {
        if (EDIT_TOOLS.has(tool)) turnEdits += 1
        noteTasks(tool, e as unknown as Record<string, unknown>, ran.result)
      }

      scheduleActivity($)
    } else {
      activity = agentTool(activity, e.agentId, null)
      scheduleActivity($, AGENT_COALESCE_MS)
    }
  } catch {
    // As above.
  }
}

/** Finished agents leave the line once they have lingered. */
async function pruneActivity($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const pruned = pruneAgents(activity, now)

    if (pruned !== null) {
      activity = pruned
      await publishActivity($)
    }
  } catch {
    // The next tick tries again.
  }
}

// ── the prompt cache ──

async function publishCache($: EngineInterface) {
  try {
    await sync('cache', cache, value => update($, cached, () => value))
  } catch {
    // As above.
  }
}

/**
 * A TTL the session showed: it holds from now on, and for the sessions after,
 * unless something surer has said otherwise. A guess never overrides a sight.
 */
function adoptTtl($: EngineInterface, ttlMs: number, source: Exclude<TtlSource, 'assumed'>) {
  if (TTL_RANK[source] < TTL_RANK[ttlSource]) return

  ttlSource = source

  if (cache.isTtlKnown && cache.ttlMs === ttlMs) return

  cache = { ...cache, ttlMs, isTtlKnown: true }
  $.store.set(TTL_KEY, ttlMs).catch(() => {})
}

/**
 * Reads the TTL off the end of the transcript, where each response's cache
 * writes are split by TTL. Once a session it is found, it is not read again;
 * where there is no `tail` (or nothing written yet) it gives up after a few.
 */
async function readTtl($: EngineInterface, transcript: string) {
  if (ttlReads >= TTL_READS || transcript === '') return

  ttlReads += 1

  try {
    const ran = await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), transcript], { timeoutMs: 3_000 })
    const ttlMs = ran.exitCode === 0 ? ttlOfTranscript(ran.stdout) : null

    if (ttlMs === null) return

    ttlReads = TTL_READS
    adoptTtl($, ttlMs, 'seen')
    await publishCache($)
  } catch {
    // The gap between requests still teaches it, more slowly.
  }
}

/** A main-loop request came back: the entry is fresh from when it went out, for as long as its TTL. */
async function noteRequest($: EngineInterface, sentAt: number, spent: TurnUsage) {
  const hitRatio = hitRatioOf(spent)
  const gap = cache.lastRequestAt === null ? null : sentAt - cache.lastRequestAt
  const learnt = gap !== null && hitRatio !== null ? learnTtl(gap, hitRatio) : null

  if (learnt !== null) adoptTtl($, learnt, 'learnt')

  cache = {
    ...cache,
    lastRequestAt: sentAt,
    hitRatio,
    tokens: spent.input_tokens + spent.cache_read_input_tokens + spent.cache_creation_input_tokens,
  }

  await publishCache($)
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

/**
 * A resumed session's cache is as old as its last reply: the engine says how
 * long ago that was, and whether the entry has outlived it, which says the
 * TTL too: still warm past five minutes is an hour, gone within one is five
 * minutes.
 */
async function noteResume($: EngineInterface, since: number | undefined, tokens: number | undefined, isExpired: boolean | undefined) {
  if (since === undefined) return

  try {
    await ensureStarted($)

    const now = await $.clock.now()
    const sinceMs = since * 1_000

    if (isExpired === false && sinceMs > TTL_5M) adoptTtl($, TTL_1H, 'seen')
    if (isExpired === true && sinceMs < TTL_1H) adoptTtl($, TTL_5M, 'seen')

    cache = { ...cache, lastRequestAt: now - sinceMs, tokens: tokens ?? cache.tokens, hitRatio: null }
    await publishCache($)
  } catch {
    // The first request sets it right.
  }
}

async function tick($: EngineInterface) {
  try {
    await sync('now', await $.clock.now(), value => update($, clock, () => value))
  } catch {
    // The countdowns move on the next tick.
  }

  void refreshGit($)
  void pruneActivity($)
  // Catches /config turning auto-compact off or on between replies.
  void refreshBreakdown($)
  await refreshIdentity($)
}

/**
 * A reload (an edit, an option changed in /config) starts this module over,
 * but the host keeps what it last drew: the band picks up from there instead
 * of forgetting the fill's history, the cache's clock and the running agents.
 * A session that ended cleared them, so a new one starts from nothing.
 */
async function resume($: EngineInterface) {
  const [was, wasDoing, wasCached, who] = await Promise.all([
    read($, usage),
    read($, doing),
    read($, cached),
    read($, identity),
  ])

  // Each only where no event has set it meanwhile: what came in since is newer.
  if (was.tokens !== null && figures === null) {
    figures = was
    history = was.history
    parts = was.parts
    compactAt = was.compactAt
    isAutoCompact = was.isAutoCompact
  }

  // Nothing is in flight across a reload: it waits for a turn to end.
  if (activity === EMPTY_ACTIVITY) activity = { ...wasDoing, turnStartedAt: null, running: [] }

  if (cache.lastRequestAt === null && wasCached.lastRequestAt !== null) {
    cache = wasCached
    ttlSource = wasCached.isTtlKnown ? 'seen' : 'assumed'
  }

  if (who.model !== '' && lastIdentity === null) {
    lastIdentity = who
    effort = who.effort
    // The settings are read next; they are a baseline then, not the person changing them.
    isEffortRestored = true
  }

  if (!written.has('usage')) written.set('usage', JSON.stringify(was))
  if (!written.has('identity')) written.set('identity', JSON.stringify(who))
}

async function begin($: EngineInterface) {
  // The first prompt waits on `session.start`, so this waits on the store
  // and the state alone: git and the disk are read in the background.
  const [stored, ttl] = await Promise.all([
    $.store.get(STORE_KEY).catch(() => undefined),
    $.store.get(TTL_KEY).catch(() => undefined),
    resume($).catch(() => {}),
  ])

  windows = toWindows(stored)

  const knownTtl = toTtl(ttl)

  // What an earlier session saw is the best guess until this one sees it too.
  if (knownTtl !== null && !cache.isTtlKnown) cache = { ...cache, ttlMs: knownTtl }

  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => {
    void tick($)
  })

  void Promise.all([tick($), refreshUsage($), publishCache($), publishActivity($)])
}

/**
 * What a session that ended leaves behind: nothing of its own. The windows
 * are the account's and stay; the TTL stays the best guess.
 */
async function clearSession($: EngineInterface) {
  const was = figures

  figures = null
  history = []
  parts = []
  lastFuelLevel = null
  ttlReads = 0
  ttlSource = 'assumed'
  activity = EMPTY_ACTIVITY
  // What the TTL was stays the best guess; the next session confirms it for itself.
  cache = { ...EMPTY_CACHE, ttlMs: cache.ttlMs }

  try {
    await Promise.all([
      sync('usage', { ...(was ?? (await read($, usage))), tokens: null, history: [], parts: [], costUsd: null }, value =>
        update($, usage, () => value),
      ),
      publishActivity($),
      publishCache($),
    ])
  } catch {
    // The next session's first figures write over them.
  }
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

// ── drawing ──

function clockProps(live: Extract<Live, { kind: 'clock' }>): ClockProps {
  const { kind: _, ...props } = live

  return props
}

/** A live part as the surface module that keeps it ticking. The paths are read off this source, so they are literals. */
function liveElement(Client: ElementConstructor<ClientProps>, live: Live, key: string): RenderElement {
  return live.kind === 'clock' ? (
    <Client key={key} module="./live/clock.ts" props={clockProps(live)} />
  ) : (
    <Client key={key} module="./live/spinner.ts" props={{ color: live.color }} />
  )
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)
  hasAlerts = options.alerts !== false

  // ── events ──

  on('session.start', async ($, e, next) => {
    await ensureStarted($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    beginning = null
    // A /clear ends the session: the next one's context starts from nothing.
    await clearSession($)

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
      // The conversation the cache held is gone; the next request writes the new one.
      cache = { ...cache, lastRequestAt: null, hitRatio: null, tokens: result.tokensAfter }
      void publishCache($)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume' || e.source === 'fork') {
      void readTtl($, e.transcript_path)
      void noteResume($, e.seconds_since_last_response, e.context_tokens, e.prompt_cache_likely_expired)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The main loop's turn is written down: its responses' cache writes say the TTL.
  on('classic.Stop', async ($, e, next) => {
    void readTtl($, e.transcript_path)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await ensureStarted($)
    await beginTurn($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await ensureStarted($)

    if (e.agentId === undefined) {
      // A subagent's files reach git through its tools; its turns ask nothing more.
      void refreshGit($)
      void refreshIdentity($)
      await noteTurnEnd($)
      await finishTurn($, e.durationMs, e.reason)
    } else {
      const now = await $.clock.now()
      const before = activity

      activity = finishAgent(activity, e.agentId, agentStatusOf(e.reason), now)

      if (activity !== before) {
        scheduleActivity($)
        $.clock.after(AGENT_LINGER_MS + 100, () => {
          void pruneActivity($)
        })
      }
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($)
    void refreshIdentity($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A model request: the one place that says what effort it runs at, and,
  // once it is back, what the context holds mid-turn and how the cache took
  // it. Observed, forwarded untouched.
  on('turn.step', async function* ($, e, next) {
    // Only the main thread's own requests: a subagent runs at an effort and a context of its own.
    const isMain = e.agentId === undefined
    // When the request went out, read as it goes: the cache counts from there.
    const sent = isMain ? $.clock.now().catch(() => null) : null

    if (isMain) void noteEffort($, e.effort)

    const result = yield* next(e)
    const spent = result.usage

    if (sent !== null && spent !== null) {
      await noteFill(
        $,
        spent.input_tokens + spent.cache_read_input_tokens + spent.cache_creation_input_tokens,
      )

      const sentAt = await sent

      try {
        if (sentAt !== null) await noteRequest($, sentAt, spent)
      } catch {
        // The cache line waits for the next request.
      }
    }

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const at = $.clock.now().catch(() => null)
    const started = await next(e)
    const startedAt = await at

    // Read the clock before the change: agents spawned together must all land.
    if (started.agentId !== undefined && startedAt !== null) {
      activity = spawnAgent(activity, {
        id: started.agentId,
        type: e.subagentType,
        description: e.description,
        startedAt,
        endedAt: null,
        status: 'running',
        tools: 0,
        doing: null,
        isBackground: e.background,
      })
      scheduleActivity($)
    }

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    await noteToolStart($, e)

    const ran = await next(e)

    await noteToolEnd($, e, ran)

    if (MAY_TOUCH_FILES.has(String(e.tool))) scheduleGit($)

    return ran
  }).catch(($, e, next) => next(e))

  // ── drawing ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever other plugins drew stays, above this band.
    const below = await next(e)

    // A survey has the band; the status waits.
    if (e.props.hasSurvey) return below

    const [who, repo, current, doingNow, cacheNow, now, ticked] = await Promise.all([
      read($, identity),
      read($, git),
      read($, usage),
      read($, doing),
      read($, cached),
      $.clock.now(),
      // Read to redraw on each tick, so reset countdowns move.
      read($, clock),
    ])
    const isTerminal = e.surface === 'terminal'
    // One cell of margin on the left, so the band lines up with the prompt's text.
    const columns = Math.max(1, e.props.bodyColumns - 1)
    const lines = arrange(
      {
        identity: who,
        git: repo,
        usage: current,
        activity: doingNow,
        cache: cacheNow,
        now: Math.max(now, ticked),
        isWorking: e.props.isWorking,
        isTerminal,
      },
      settings,
      columns,
    )

    if (lines.length === 0) return below

    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Client = 'Client' in els ? els.Client : null
    const palette = paletteOf(isTerminal)
    const band = view(
      { Box, Button, Text },
      lines,
      {
        copy: text => press => copyText($, press.surface, text),
        compact: () => offerCompact($),
        live: (live, key) => (Client === null ? null : liveElement(Client, live, key)),
      },
      {
        columns,
        separator: separatorPart(settings),
        hasCards: settings.hasCards,
        hover: palette.hover,
        border: palette.border,
      },
    )

    return (
      <Box flexDirection="column">
        {below}
        {band}
      </Box>
    )
  })
}
