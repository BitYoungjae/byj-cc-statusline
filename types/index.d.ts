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

declare module 'claude-code' {
  interface PluginState {
    'byj-statusline': {
      identity: Identity
      git: GitInfo | null
      usage: Usage
      /** Wall clock in ms, ticked so reset countdowns stay current. */
      now: number
    }
  }
}
