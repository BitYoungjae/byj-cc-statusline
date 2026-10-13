// What the session is doing, kept as plain values: each event the engine
// raises (a tool starting and ending, a subagent spawned and done, a task
// list written) is one function from the activity before to the activity
// after. The hooks module calls them; nothing here touches `$`.

import type { Activity, AgentRun, AgentStatus, TaskItem, ToolCount, ToolRun, TurnReceipt } from '../../types'
import { baseName, clip } from './format'

export const EMPTY_ACTIVITY: Activity = {
  turnStartedAt: null,
  running: [],
  tally: [],
  agents: [],
  tasks: [],
  lastTurn: null,
}

/** How long a finished subagent stays on the line, so its end is seen. */
export const AGENT_LINGER_MS = 30_000
/** The most subagents kept: every running one, then the latest finished up to this many in all. */
const MAX_AGENTS = 8

/** The tools that write files: what a receipt counts as edits. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `mcp__github__create_issue` reads as `create_issue`; a built-in keeps its name. */
export function toolName(tool: string): string {
  const match = /^mcp__.+?__(.+)$/.exec(tool)

  return match?.[1] ?? tool
}

/** The host a URL names, or the URL as it is when it names none. */
function host(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)

  return match?.[1] ?? url
}

/**
 * What a tool call works on, as short as it reads: the file's name, the
 * command's first line, the pattern, the host. Empty when there is nothing
 * worth naming.
 */
export function describeTool(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return baseName(text(input.file_path))
    case 'NotebookEdit':
      return baseName(text(input.notebook_path))
    case 'Bash':
      return clip(text(input.command).split('\n')[0]?.trim() ?? '', 32)
    case 'Grep':
    case 'Glob':
      return clip(text(input.pattern), 24)
    case 'WebFetch':
      return host(text(input.url))
    case 'WebSearch':
      return clip(text(input.query), 24)
    case 'Agent':
      return text(input.subagent_type) || clip(text(input.description), 24)
    case 'Skill':
      return text(input.skill)
    default:
      return ''
  }
}

/** A tool run as one phrase: `Edit view.ts`, `Bash npm test`, `Glob`. */
export function phrase(tool: string, target: string): string {
  const name = toolName(tool)

  return target === '' ? name : `${name} ${target}`
}

// ── the main loop's turn ──

export function startTurn(activity: Activity, at: number): Activity {
  return { ...activity, turnStartedAt: at, running: [], tally: [] }
}

export function endTurn(activity: Activity, receipt: TurnReceipt): Activity {
  return { ...activity, turnStartedAt: null, running: [], lastTurn: receipt }
}

export function startTool(activity: Activity, run: ToolRun): Activity {
  return { ...activity, running: [...activity.running.filter(one => one.id !== run.id), run] }
}

/** A tool came back: it leaves the running ones and counts toward the turn's tally. */
export function finishTool(activity: Activity, id: string, tool: string, isError: boolean): Activity {
  const name = toolName(tool)
  const tally: ToolCount[] = activity.tally.some(one => one.tool === name)
    ? activity.tally.map(one =>
        one.tool === name ? { ...one, count: one.count + 1, errors: one.errors + (isError ? 1 : 0) } : one,
      )
    : [...activity.tally, { tool: name, count: 1, errors: isError ? 1 : 0 }]

  return {
    ...activity,
    running: activity.running.filter(one => one.id !== id),
    // Most used first; a tie keeps the order the tools first ran in.
    tally: tally
      .map((one, index) => ({ one, index }))
      .sort((a, b) => b.one.count - a.one.count || a.index - b.index)
      .map(({ one }) => one),
  }
}

export type ReceiptInput = {
  startedAt: number
  endedAt: number
  tally: readonly ToolCount[]
  edits: number
  reason: TurnReceipt['reason']
  cost: { before: number | null; after: number | null }
  fill: { before: number | null; after: number | null }
}

export function receiptOf(input: ReceiptInput): TurnReceipt {
  const { cost, fill } = input
  const spent = cost.before !== null && cost.after !== null ? cost.after - cost.before : null

  return {
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    tools: input.tally.reduce((sum, one) => sum + one.count, 0),
    edits: input.edits,
    errors: input.tally.reduce((sum, one) => sum + one.errors, 0),
    // Under half a cent is rounding, not spend.
    costUsd: spent !== null && spent >= 0.005 ? spent : null,
    grewBy: fill.before !== null && fill.after !== null ? fill.after - fill.before : null,
    reason: input.reason,
  }
}

// ── subagents ──

/**
 * Running agents first, oldest first; then the finished ones, latest first.
 * A workflow can run dozens at once: none that runs is dropped, only the
 * finished ones past the cap.
 */
function ordered(agents: readonly AgentRun[]): AgentRun[] {
  const running = agents.filter(one => one.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const finished = agents
    .filter(one => one.status !== 'running')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

  return [...running, ...finished.slice(0, Math.max(0, MAX_AGENTS - running.length))]
}

export function spawnAgent(activity: Activity, agent: AgentRun): Activity {
  return { ...activity, agents: ordered([...activity.agents.filter(one => one.id !== agent.id), agent]) }
}

/** A tool inside an agent's loop started (`doing` its phrase) or came back (`doing` null). */
export function agentTool(activity: Activity, agentId: string, doing: string | null): Activity {
  if (!activity.agents.some(one => one.id === agentId)) return activity

  return {
    ...activity,
    agents: activity.agents.map(one =>
      one.id === agentId ? { ...one, doing, tools: one.tools + (doing === null ? 1 : 0) } : one,
    ),
  }
}

export function finishAgent(activity: Activity, agentId: string, status: AgentStatus, at: number): Activity {
  if (!activity.agents.some(one => one.id === agentId && one.status === 'running')) return activity

  return {
    ...activity,
    agents: ordered(
      activity.agents.map(one => (one.id === agentId ? { ...one, status, endedAt: at, doing: null } : one)),
    ),
  }
}

/** Finished agents leave once they have lingered; null when none did, so nothing redraws. */
export function pruneAgents(activity: Activity, now: number): Activity | null {
  const agents = activity.agents.filter(
    one => one.status === 'running' || (one.endedAt ?? 0) + AGENT_LINGER_MS > now,
  )

  return agents.length === activity.agents.length ? null : { ...activity, agents }
}

export function agentStatusOf(reason: string): AgentStatus {
  if (reason === 'aborted') return 'stopped'

  return reason === 'answer' ? 'done' : 'failed'
}

// ── tasks ──

type Status = TaskItem['status']

function status(value: unknown): Status | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
}

/** TodoWrite hands the whole list each time: it replaces what was there. */
export function todoList(todos: unknown): TaskItem[] {
  if (!Array.isArray(todos)) return []

  return todos.flatMap((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null) return []

    const todo = raw as Record<string, unknown>
    const state = status(todo.status)
    const subject = text(todo.content)

    if (state === null || subject === '') return []

    return [{ id: `todo-${index}`, subject, activeForm: text(todo.activeForm) || null, status: state }]
  })
}

export function createTask(tasks: readonly TaskItem[], id: string, subject: string, activeForm: string | null): TaskItem[] {
  return [...tasks.filter(one => one.id !== id), { id, subject, activeForm, status: 'pending' }]
}

export type TaskChange = {
  taskId: string
  status?: unknown
  subject?: unknown
  activeForm?: unknown
}

export function updateTask(tasks: readonly TaskItem[], change: TaskChange): TaskItem[] {
  if (change.status === 'deleted') return tasks.filter(one => one.id !== change.taskId)

  return tasks.map(one => {
    if (one.id !== change.taskId) return one

    return {
      ...one,
      status: status(change.status) ?? one.status,
      subject: text(change.subject) || one.subject,
      activeForm: text(change.activeForm) || one.activeForm,
    }
  })
}

export type Progress = {
  done: number
  total: number
  /** The task in progress, else the next one waiting; null when all are done. */
  current: TaskItem | null
}

export function progress(tasks: readonly TaskItem[]): Progress {
  return {
    done: tasks.filter(one => one.status === 'completed').length,
    total: tasks.length,
    current:
      tasks.find(one => one.status === 'in_progress') ?? tasks.find(one => one.status === 'pending') ?? null,
  }
}

// ── whether there is anything to show ──

export function hasRunningAgents(activity: Activity): boolean {
  return activity.agents.some(one => one.status === 'running')
}

/**
 * Whether the activity line has anything to say. While a turn runs, always.
 * Between turns, only for what goes on without the person: a subagent still
 * working (or just finished), a task still in progress.
 */
export function isLive(activity: Activity, isWorking: boolean): boolean {
  if (isWorking) return true
  if (activity.agents.length > 0) return true

  return activity.tasks.some(one => one.status === 'in_progress')
}
