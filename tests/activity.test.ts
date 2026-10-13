import { describe, expect, test } from 'claude-code/testing'

import {
  agentStatusOf,
  agentTool,
  AGENT_LINGER_MS,
  createTask,
  describeTool,
  EMPTY_ACTIVITY,
  endTurn,
  finishAgent,
  finishTool,
  isLive,
  phrase,
  progress,
  pruneAgents,
  receiptOf,
  spawnAgent,
  startTool,
  startTurn,
  todoList,
  toolName,
  updateTask,
} from '../hooks/lib/activity'
import { agent, NOW } from './fixtures'

describe('what a tool works on', () => {
  test('files by their name, commands by their first line, patterns as written', () => {
    expect(describeTool('Read', { file_path: '/w/proj/hooks/lib/view.ts' })).toBe('view.ts')
    expect(describeTool('Edit', { file_path: '/w/a.ts', old_string: 'x' })).toBe('a.ts')
    expect(describeTool('NotebookEdit', { notebook_path: '/w/n.ipynb' })).toBe('n.ipynb')
    expect(describeTool('Bash', { command: 'npm test\nnpm run lint' })).toBe('npm test')
    expect(describeTool('Grep', { pattern: 'ui\\.render' })).toBe('ui\\.render')
    expect(describeTool('WebFetch', { url: 'https://docs.example.com/a/b?c' })).toBe('docs.example.com')
    expect(describeTool('Agent', { subagent_type: 'Explore', description: 'look' })).toBe('Explore')
  })

  test('a long command is cut in its middle', () => {
    expect(describeTool('Bash', { command: 'x'.repeat(80) })).toHaveLength(32)
  })

  test('a tool with nothing to name names nothing, and arguments of the wrong kind are none', () => {
    expect(describeTool('TaskList', {})).toBe('')
    expect(describeTool('Read', { file_path: 42 })).toBe('')
  })

  test('an MCP tool goes by its own name', () => {
    expect(toolName('mcp__github__create_issue')).toBe('create_issue')
    expect(toolName('Read')).toBe('Read')
    expect(phrase('mcp__github__create_issue', '')).toBe('create_issue')
    expect(phrase('Edit', 'a.ts')).toBe('Edit a.ts')
  })
})

describe('the turn`s tools', () => {
  const run = (id: string, tool: string) => ({ id, tool, target: '', startedAt: NOW })

  test('a tool runs, then counts toward the tally', () => {
    let activity = startTurn(EMPTY_ACTIVITY, NOW)

    activity = startTool(activity, run('1', 'Read'))
    expect(activity.running.map(one => one.id)).toEqual(['1'])

    activity = finishTool(activity, '1', 'Read', false)
    expect(activity.running).toEqual([])
    expect(activity.tally).toEqual([{ tool: 'Read', count: 1, errors: 0 }])
  })

  test('the tally is most used first, ties in the order they first ran', () => {
    let activity = EMPTY_ACTIVITY

    for (const tool of ['Bash', 'Read', 'Grep', 'Read', 'Grep', 'Read']) activity = finishTool(activity, tool, tool, false)

    expect(activity.tally.map(one => `${one.tool}×${one.count}`)).toEqual(['Read×3', 'Grep×2', 'Bash×1'])
  })

  test('errors are counted beside the runs', () => {
    const activity = finishTool(finishTool(EMPTY_ACTIVITY, '1', 'Bash', true), '2', 'Bash', false)

    expect(activity.tally).toEqual([{ tool: 'Bash', count: 2, errors: 1 }])
  })

  test('a new turn starts the tally over; its end keeps the receipt', () => {
    const before = finishTool(EMPTY_ACTIVITY, '1', 'Read', false)
    const started = startTurn(before, NOW)

    expect(started.tally).toEqual([])
    expect(started.turnStartedAt).toBe(NOW)

    const receipt = receiptOf({
      startedAt: NOW,
      endedAt: NOW + 90_000,
      tally: before.tally,
      edits: 0,
      reason: 'answer',
      cost: { before: 1, after: 1.25 },
      fill: { before: 40_000, after: 52_000 },
    })
    const ended = endTurn(started, receipt)

    expect(ended.turnStartedAt).toBeNull()
    expect(ended.lastTurn).toEqual({
      durationMs: 90_000,
      tools: 1,
      edits: 0,
      errors: 0,
      costUsd: 0.25,
      grewBy: 12_000,
      reason: 'answer',
    })
  })

  test('a receipt leaves out spend under half a cent, and what it cannot know', () => {
    const receipt = receiptOf({
      startedAt: 0,
      endedAt: 1,
      tally: [],
      edits: 0,
      reason: 'aborted',
      cost: { before: 1, after: 1.001 },
      fill: { before: null, after: 5 },
    })

    expect(receipt.costUsd).toBeNull()
    expect(receipt.grewBy).toBeNull()
  })
})

describe('subagents', () => {
  test('one spawned runs; its tools say what it does and count', () => {
    let activity = spawnAgent(EMPTY_ACTIVITY, agent({ tools: 0, doing: null }))

    activity = agentTool(activity, 'a1', 'Read a.ts')
    expect(activity.agents[0]?.doing).toBe('Read a.ts')

    activity = agentTool(activity, 'a1', null)
    expect(activity.agents[0]).toMatchObject({ doing: null, tools: 1 })
  })

  test('a tool of an agent the line never saw changes nothing', () => {
    expect(agentTool(EMPTY_ACTIVITY, 'nobody', 'Read a.ts')).toBe(EMPTY_ACTIVITY)
  })

  test('it finishes once, by how its turn ended', () => {
    const running = spawnAgent(EMPTY_ACTIVITY, agent())
    const done = finishAgent(running, 'a1', agentStatusOf('answer'), NOW)

    expect(done.agents[0]).toMatchObject({ status: 'done', endedAt: NOW, doing: null })
    expect(finishAgent(done, 'a1', 'failed', NOW + 5)).toBe(done)
    expect(agentStatusOf('aborted')).toBe('stopped')
    expect(agentStatusOf('error')).toBe('failed')
  })

  test('running agents come first, then the latest finished', () => {
    let activity = EMPTY_ACTIVITY

    activity = spawnAgent(activity, agent({ id: 'old', startedAt: NOW - 50 }))
    activity = spawnAgent(activity, agent({ id: 'new', startedAt: NOW - 10 }))
    activity = finishAgent(activity, 'old', 'done', NOW)

    expect(activity.agents.map(one => one.id)).toEqual(['new', 'old'])
  })

  test('a finished agent lingers, then leaves', () => {
    const done = finishAgent(spawnAgent(EMPTY_ACTIVITY, agent()), 'a1', 'done', NOW)

    expect(pruneAgents(done, NOW + AGENT_LINGER_MS - 1)).toBeNull()
    expect(pruneAgents(done, NOW + AGENT_LINGER_MS)?.agents).toEqual([])
  })

  test('every running agent is kept; finished ones only up to eight in all', () => {
    let activity = EMPTY_ACTIVITY

    for (let index = 0; index < 12; index += 1) activity = spawnAgent(activity, agent({ id: `a${index}`, startedAt: NOW + index }))

    expect(activity.agents).toHaveLength(12)

    for (let index = 0; index < 6; index += 1) activity = finishAgent(activity, `a${index}`, 'done', NOW + 100 + index)

    // Six still run; of the six finished, the two latest stay.
    expect(activity.agents.map(one => one.id)).toEqual(['a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a5', 'a4'])
  })
})

describe('tasks', () => {
  test('TodoWrite replaces the list, skipping what is not a todo', () => {
    const tasks = todoList([
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship', status: 'pending', activeForm: '' },
      { content: '', status: 'pending' },
      'nonsense',
    ])

    expect(tasks.map(one => [one.subject, one.status, one.activeForm])).toEqual([
      ['Read the code', 'completed', 'Reading the code'],
      ['Write tests', 'in_progress', 'Writing tests'],
      ['Ship', 'pending', null],
    ])
    expect(todoList(undefined)).toEqual([])
  })

  test('TaskCreate adds one waiting, TaskUpdate moves it on or deletes it', () => {
    let tasks = createTask([], '1', 'Survey', 'Surveying')

    tasks = createTask(tasks, '2', 'Count', null)
    tasks = updateTask(tasks, { taskId: '1', status: 'in_progress' })
    expect(tasks.map(one => one.status)).toEqual(['in_progress', 'pending'])

    tasks = updateTask(tasks, { taskId: '2', subject: 'Count files', status: 'bogus' })
    expect(tasks[1]).toMatchObject({ subject: 'Count files', status: 'pending' })

    tasks = updateTask(tasks, { taskId: '1', status: 'deleted' })
    expect(tasks.map(one => one.id)).toEqual(['2'])
  })

  test('progress names the task under way, else the next waiting', () => {
    const tasks = todoList([
      { content: 'A', status: 'completed', activeForm: 'Doing A' },
      { content: 'B', status: 'pending', activeForm: 'Doing B' },
      { content: 'C', status: 'in_progress', activeForm: 'Doing C' },
    ])

    expect(progress(tasks)).toMatchObject({ done: 1, total: 3, current: { subject: 'C' } })
    expect(progress(tasks.slice(0, 2)).current?.subject).toBe('B')
    expect(progress(tasks.slice(0, 1)).current).toBeNull()
  })
})

describe('whether the line has anything to say', () => {
  test('while a turn runs, always; between turns, only for what goes on alone', () => {
    expect(isLive(EMPTY_ACTIVITY, true)).toBe(true)
    expect(isLive(EMPTY_ACTIVITY, false)).toBe(false)
    expect(isLive(spawnAgent(EMPTY_ACTIVITY, agent()), false)).toBe(true)

    const waiting = { ...EMPTY_ACTIVITY, tasks: createTask([], '1', 'A', null) }

    expect(isLive(waiting, false)).toBe(false)
    expect(isLive({ ...waiting, tasks: updateTask(waiting.tasks, { taskId: '1', status: 'in_progress' }) }, false)).toBe(true)
  })
})
