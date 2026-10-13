import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { NOW } from './fixtures'

const NAME = 'byj-statusline'
const props = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 200,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
}
const ONE_HOUR_LINE = '{"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":1945,"ephemeral_5m_input_tokens":0}}}}'

// Beneath the plugins the engine draws its own band: here, an empty one.
const engineBand = (on: On) =>
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return Box({})
  })

// The band reads state only its own hooks write, so the test plays the engine:
// it answers what the plugin asks, and a prompt wakes the plugin to ask.
async function wake($: Engine, on: On, clock: MockClock) {
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('settings.read', () => ({ value: { modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'high' } } } }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ value: [{ name: '1.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] }))
  on('fs.read', () => ({ value: JSON.stringify({ sessionId: 'sid-1', name: 'proj-a4', updatedAt: 1 }) }))
  on('config.list', () => ({ value: [] }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'tail' ? 0 : 128,
      stdout: e.argv[0] === 'tail' ? ONE_HOUR_LINE : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('session.end', () => ({ sessionId: 'sid-1' }) as never)
  mock.store(on)

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await clock.advance(100)
}

const texts = async (ui: { findAll: (query: { type: string }) => Promise<readonly { text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '')

describe('the band', () => {
  test('draws on the terminal and the desktop', async ($, on) => {
    mock.clock(on, { now: NOW })
    engineBand(on)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: NAME, surface, component: 'AbovePrompt', props })

      // Nothing has been measured yet, so the gauge holds its place.
      expect(await ui.find({ type: 'Text', text: /fuel/ })).toBeDefined()
      // The surface's own table accepts the tree, hover cards and all.
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect(await ui.find({ type: 'Box', key: 'seg:fuel' })).toBeDefined()

      await ui.unmount()
    }
  })

  test('shows who the session is, the model on its badge with the effort beside it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)

    await wake($, on, clock)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })
    const shown = await texts(ui)

    expect(shown).toContain(' Sonnet 5.5 ')
    expect(shown).toContain('high')
    expect(shown).toContain('proj-a4')

    await ui.unmount()
  })

  test('a click on a name copies it, and says so', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
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

      await ui.press({ key: 'copy:place' })
      await ui.press({ key: 'copy:model' })
      await ui.unmount()
    }

    expect(copied).toEqual(['proj-a4', 'claude-sonnet-5-5', 'proj-a4', 'claude-sonnet-5-5'])
    expect(toasts[0]).toBe('Copied proj-a4')
    expect(toasts[1]).toBe('Copied claude-sonnet-5-5')
  })
})

describe('the activity line', () => {
  test('follows the turn: the tool in flight, a turning spinner, then the tally', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    on('tool.call', async () => {
      await clock.sleep(5_000)

      return { result: { ok: true } } as never
    })

    await wake($, on, clock)
    await $.turn.start({ text: 'go', turnId: 't1' })

    const call = $.tool.call({ tool: 'Read', file_path: '/w/proj/hooks/view.ts' } as never)

    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: { ...props, isWorking: true } })

    expect(await texts(ui)).toEqual(expect.arrayContaining(['Read', ' view.ts']))

    // The spinner turns on the surface's clock, the band untouched.
    const spinner = 'live:now:0'
    const first = (await ui.find({ type: 'Text', in: spinner }))?.text

    await ui.advance(120)
    expect((await ui.find({ type: 'Text', in: spinner }))?.text).not.toBe(first)

    await clock.advance(5_000)
    await call
    await clock.advance(100)

    expect(await texts(ui)).toEqual(expect.arrayContaining(['Read', ' ×1']))
    expect(await texts(ui)).not.toContain(' view.ts')

    await ui.unmount()
  })

  test('a subagent shows from its spawn, its clock ticking, until it has lingered', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))

    await wake($, on, clock)
    await $.agent.spawn({ prompt: 'p', description: 'find the hooks', subagentType: 'Explore', background: true } as never)
    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })

    expect(await texts(ui)).toEqual(expect.arrayContaining(['■', ' Explore', ' find the hooks']))

    const drawn = JSON.stringify(await ui.drawn())
    const key = /"key":"(live:agents:\d+)"/.exec(drawn)?.[1] ?? ''

    expect((await ui.find({ type: 'Text', in: key }))?.text).toBe('0:00 ')
    await ui.advance(2_000)
    expect((await ui.find({ type: 'Text', in: key }))?.text).toBe('0:02 ')

    await $.turn.complete({ answer: 'found', durationMs: 4_000, isAborted: false, turnId: 'x', agentId: 'ag1', reason: 'answer' })
    await clock.advance(100)
    expect(await texts(ui)).toContain('✓')

    await clock.advance(31_000)
    expect(await texts(ui)).not.toContain(' Explore')

    await ui.unmount()
  })
})

describe('events that land together', () => {
  test('agents spawned at once all show', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: `id-${e.subagentType}` }))

    await wake($, on, clock)
    await Promise.all(
      ['Explore', 'Plan', 'Review'].map(type =>
        $.agent.spawn({ prompt: 'p', description: '', subagentType: type, background: true } as never),
      ),
    )
    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })

    expect(await texts(ui)).toEqual(expect.arrayContaining([' Explore', ' Plan', '  +1']))

    await ui.unmount()
  })

  test('tools started at once all run, and all count when done', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    on('tool.call', async () => {
      await clock.sleep(1_000)

      return { result: { ok: true } } as never
    })

    await wake($, on, clock)
    await $.turn.start({ text: 'go', turnId: 't1' })

    const calls = ['a.ts', 'b.ts', 'c.ts'].map(file => $.tool.call({ tool: 'Read', file_path: `/w/${file}` } as never))

    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: { ...props, isWorking: true } })

    expect(await texts(ui)).toContain(' +2')

    await clock.advance(1_000)
    await Promise.all(calls)
    await clock.advance(100)
    expect(await texts(ui)).toEqual(expect.arrayContaining(['Read', ' ×3']))

    await ui.unmount()
  })
})

describe('the prompt cache', () => {
  /** The engine's answer to a request: almost all of it read from the cache. */
  function answerSteps(on: On) {
    on('turn.step', async function* (_, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 990, model: 'm' },
      }
    })
  }

  async function request($: Engine) {
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })

    for await (const _ of stream) {
      // The chunks are the engine's; the cache reads the result.
    }

    await stream.result
  }

  test('counts down between turns on the surface`s clock, then reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    answerSteps(on)

    await wake($, on, clock)
    await request($)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })
    const key = 'live:cache:1'

    expect((await ui.find({ type: 'Text', in: key }))?.text).toBe('5:00')
    await ui.advance(1_000)
    expect((await ui.find({ type: 'Text', in: key }))?.text).toBe('4:59')
    await ui.advance(300_000)
    expect((await ui.find({ type: 'Text', in: key }))?.text).toBe('cold')

    await ui.unmount()
  })

  test('reads the TTL off the transcript once a turn is written down', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    answerSteps(on)

    await wake($, on, clock)
    await request($)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/home/me/.claude/projects/p/sid-1.jsonl' })
    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })

    expect((await ui.find({ type: 'Text', in: 'live:cache:1' }))?.text).toBe('60m ')
    expect(await ui.find({ type: 'Text', text: 'an hour' })).toBeDefined()

    await ui.unmount()
  })

  test('a resumed session whose cache has lapsed reads cold, whatever the transcript says of the TTL', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)

    await wake($, on, clock)
    await $.classic.SessionStart({
      source: 'resume',
      transcript_path: '/home/me/.claude/projects/p/sid-1.jsonl',
      seconds_since_last_response: 4_000,
      prompt_cache_likely_expired: true,
      context_tokens: 120_000,
    })
    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })

    expect(await texts(ui)).toContain('cold')
    expect(await ui.find({ type: 'Text', text: '~120K' })).toBeDefined()

    await ui.unmount()
  })

  test('a cleared session forgets the old conversation`s cache and activity', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engineBand(on)
    answerSteps(on)
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))

    await wake($, on, clock)
    await request($)
    await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'Explore', background: true } as never)
    await $.session.end({ reason: 'clear' } as never)
    await clock.advance(100)

    const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props })
    const shown = await texts(ui)

    expect(shown).not.toContain('cache ')
    expect(shown).not.toContain(' Explore')

    await ui.unmount()
  })
})
