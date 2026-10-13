/** Git state of the session's directory, parsed from `git status --porcelain=v2`. */
export type GitInfo = {
  /** The branch, or the short commit id while HEAD is detached. */
  branch: string
  isDetached: boolean
  /** Files with changes in the index. */
  staged: number
  /** Files with changes in the working tree. */
  modified: number
  untracked: number
  conflicted: number
  ahead: number
  behind: number
}

/** Who the session is: the model, how hard it thinks, the directory, and its messaging name. */
export type Identity = {
  model: string
  /** `low`..`max`, or whatever the engine reports; null for a model without effort. */
  effort: string | null
  /** The directory's own name, not the whole path. */
  dir: string
  /** The whole path, for a click that copies it. */
  cwd: string
  /** The name peers address in cross-session messaging, from the registry. */
  sessionName: string | null
}

/** One rate-limit window as last reported. */
export type WindowReading = {
  /** 0 to 100. */
  percentUsed: number
  /** ISO 8601, or null when the window did not say. */
  resetsAt: string | null
}

/** One row of what fills the context, as /context breaks it down. */
export type ContextPart = {
  name: string
  tokens: number
  /** The theme key /context draws the row in. */
  color: string
}

/** The figures the gauges draw. */
export type Usage = {
  /** Input tokens of the last response; null until the first one. */
  tokens: number | null
  /** The model's context window, in tokens. */
  window: number
  /** Whether auto-compaction is on, which decides the reserved buffer. */
  isAutoCompact: boolean
  /**
   * The token count at which the engine compacts, as it reports it; null
   * until a breakdown has been read, when the fixed buffer stands in for it.
   */
  compactAt: number | null
  /** What the context holds, largest first; empty until a breakdown is read. */
  parts: ContextPart[]
  /** The fill at the end of each recent main-loop turn, oldest first. */
  history: number[]
  /** Running cost in US dollars; null where the host keeps no ledger. */
  costUsd: number | null
  /** Last known reading per window, a reset one kept until the next arrives. */
  windows: { five_hour: WindowReading | null; seven_day: WindowReading | null }
}

/** A tool the main loop is running now. */
export type ToolRun = {
  /** The tool_use id, which tells two runs of one tool apart. */
  id: string
  tool: string
  /** What it works on, as short as it reads: a file name, a command, a pattern. */
  target: string
  startedAt: number
}

/** How often one tool ran this turn. */
export type ToolCount = {
  tool: string
  count: number
  errors: number
}

export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

/** A subagent the session started, while it runs and for a little while after. */
export type AgentRun = {
  id: string
  /** The agent type (`Explore`, `general-purpose`, a plugin's). */
  type: string
  /** The few words the Agent call gave the task. */
  description: string
  startedAt: number
  /** When it finished; null while it runs. */
  endedAt: number | null
  status: AgentStatus
  /** Tools it has run. */
  tools: number
  /** What it is doing now (`Read a.ts`); null between tools. */
  doing: string | null
  isBackground: boolean
}

/** One item of the main loop's task list (TodoWrite, or TaskCreate and TaskUpdate). */
export type TaskItem = {
  id: string
  subject: string
  /** What the spinner says while it is in progress (`Running tests`). */
  activeForm: string | null
  status: 'pending' | 'in_progress' | 'completed'
}

/** What the last main-loop turn came to. */
export type TurnReceipt = {
  durationMs: number
  tools: number
  /** Edits and writes among them. */
  edits: number
  errors: number
  /** What it cost; null where the host keeps no ledger or nothing moved. */
  costUsd: number | null
  /** How much the context grew over it; null without a reading on both ends. */
  grewBy: number | null
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
}

/** What the session is doing, as the activity line and its cards draw it. */
export type Activity = {
  /** When the main loop's running turn started; null between turns. */
  turnStartedAt: number | null
  /** The main loop's tools in flight, oldest first. */
  running: ToolRun[]
  /** The running turn's finished tools by name, most used first. */
  tally: ToolCount[]
  /** Subagents running, and those finished in the last little while. */
  agents: AgentRun[]
  /** The main loop's task list, in the order it was written. */
  tasks: TaskItem[]
  lastTurn: TurnReceipt | null
}

/** The main thread's prompt cache, as its requests left it. */
export type CacheState = {
  /** When the main loop's last request went out (ms); null before one, and after a compaction. */
  lastRequestAt: number | null
  /** How long an entry lives unread: five minutes, or an hour. */
  ttlMs: number
  /** Whether the TTL was seen in a response, rather than assumed. */
  isTtlKnown: boolean
  /** Share of the last request's input the cache served, 0 to 1; null before one. */
  hitRatio: number | null
  /** Input tokens the next request would write afresh once the entry has gone. */
  tokens: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'byj-statusline': {
      identity: Identity
      git: GitInfo | null
      usage: Usage
      activity: Activity
      cache: CacheState
      /** Wall clock in ms, ticked so reset countdowns stay current. */
      now: number
    }
  }
}
