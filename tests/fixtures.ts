// The figures the layout and card tests draw from: one session at noon, a
// clean repository, a context a little past half full, two usage windows.

import type { Activity, AgentRun, GitInfo, Usage } from '../types'
import { EMPTY_ACTIVITY } from '../hooks/lib/activity'
import { EMPTY_CACHE } from '../hooks/lib/cache'
import type { Frame, Settings } from '../hooks/lib/style'

export const NOW = Date.parse('2026-10-13T12:00:00Z')

export const settings: Settings = {
  layout: 'auto',
  icons: 'symbols',
  showCost: false,
  hasActivity: true,
  hasCache: true,
}

export const cleanGit: GitInfo = {
  branch: 'main',
  isDetached: false,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  ahead: 0,
  behind: 0,
}

export const usage: Usage = {
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

export function frameOf(over: Partial<Frame> = {}): Frame {
  return {
    identity: {
      model: 'claude-sonnet-5-5',
      effort: 'xhigh',
      dir: 'my-project',
      cwd: '/home/me/Work/my-project',
      sessionName: 'my-project-a4',
    },
    git: cleanGit,
    usage,
    activity: EMPTY_ACTIVITY,
    cache: EMPTY_CACHE,
    now: NOW,
    isWorking: false,
    isTerminal: true,
    ...over,
  }
}

export function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'a1',
    type: 'Explore',
    description: 'find the hooks',
    startedAt: NOW - 34_000,
    endedAt: null,
    status: 'running',
    tools: 3,
    doing: 'Read view.ts',
    isBackground: false,
    ...over,
  }
}

/** A turn under way: a tool in flight, a few finished. */
export const working: Activity = {
  ...EMPTY_ACTIVITY,
  turnStartedAt: NOW - 83_000,
  running: [{ id: 't9', tool: 'Edit', target: 'view.ts', startedAt: NOW - 1_000 }],
  tally: [
    { tool: 'Read', count: 4, errors: 0 },
    { tool: 'Grep', count: 2, errors: 0 },
    { tool: 'Bash', count: 1, errors: 1 },
  ],
}
