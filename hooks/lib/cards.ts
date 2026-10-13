// The cards behind the segments: what a glance at the band leaves out. A
// title, the one figure that sums the card up beside it, then a few rows,
// the last saying what a click does where a click does something.

import type {
  Activity,
  AgentRun,
  CacheState,
  ContextPart,
  GitInfo,
  Identity,
  TaskItem,
  TurnReceipt,
  Usage,
  WindowReading,
} from '../../types'
import { phrase, progress } from './activity'
import { cacheLeft, COLD_MATTERS_TOKENS, TTL_1H } from './cache'
import {
  ago,
  clip,
  countdown,
  dollars,
  effortStyle,
  elapsed,
  pace,
  prettyModel,
  safeLimit,
  timeLeft,
  tokensFine,
  turnsLeft,
  usageLevel,
  type Fuel,
} from './format'
import { gauge, mixGauge, sparkline } from './gauge'
import { faint, fillColor, GLYPHS, levelColor, plural, quiet, type Card, type Palette, type Part } from './style'

export const WINDOW_SPAN_MS = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}

/** The widest a mix gauge draws inside a card. */
const MIX_CELLS = 44
/** A window's gauge inside its card: four times the band's, so the pace mark reads to the hour. */
const CARD_GAUGE_CELLS = 32
/** The most rows of a list a card shows before it says how many more. */
const LIST_ROWS = 8

const hint = (text: string): Part[] => [quiet(text)]
const NAME_ROW = hint('other sessions message this one by this name')

/** Parts joined by a faint dot, the way the band's own figures sit together. */
function joined(groups: readonly Part[][]): Part[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [faint(' · '), ...group]))
}

/** What the last turn came to, in one row. */
function receiptRow(receipt: TurnReceipt): Part[] {
  const groups: Part[][] = [[{ text: elapsed(receipt.durationMs) }]]

  if (receipt.tools > 0) groups.push([{ text: plural(receipt.tools, 'tool') }])
  if (receipt.edits > 0) groups.push([{ text: plural(receipt.edits, 'edit') }])
  if (receipt.errors > 0) groups.push([{ text: plural(receipt.errors, 'error'), color: 'error' }])
  if (receipt.costUsd !== null) groups.push([{ text: dollars(receipt.costUsd) }])
  if (receipt.reason === 'aborted') groups.push([{ text: 'interrupted', color: 'warning' }])
  if (receipt.reason === 'error' || receipt.reason === 'refusal') {
    groups.push([{ text: receipt.reason === 'error' ? 'ended on an error' : 'refused', color: 'error' }])
  }

  return [quiet('last turn '), ...joined(groups)]
}

export function modelCard(identity: Identity, lastTurn: TurnReceipt | null, palette: Palette): Card {
  const rows: Part[][] = [[quiet(identity.model)]]
  let aside: Part | undefined

  if (identity.effort !== null) {
    const style = effortStyle(identity.effort)
    const lit = style.rank === 5 ? palette.ultra : palette.accent

    rows.push([
      quiet('effort '),
      ...(style.rank > 0 ? [{ text: style.lit, color: lit }, faint(style.unlit), { text: ' ' }] : []),
      { text: identity.effort, bold: true },
      ...(style.rank > 0 ? [quiet(`  ${style.rank} of 5`)] : []),
    ])
    aside = { text: identity.effort, color: style.rank === 5 ? palette.ultra : 'inactive' }
  }

  if (lastTurn !== null) rows.push(receiptRow(lastTurn))
  rows.push(hint('click to copy the model id'))

  return { title: prettyModel(identity.model), ...(aside === undefined ? {} : { aside }), rows }
}

export function placeCard(identity: Identity, place: string, isName: boolean): Card {
  return isName
    ? { title: place, rows: [NAME_ROW, [quiet(identity.cwd)], hint('click to copy the name')] }
    : { title: place, rows: [[quiet(identity.cwd || place)], hint('click to copy the path')] }
}

export function tagCard(tag: string): Card {
  return { title: tag, rows: [NAME_ROW, hint('click to copy the name')] }
}

export function gitCard(git: GitInfo): Card {
  const counts: Part[][] = []

  if (git.conflicted > 0) counts.push([{ text: `${git.conflicted} conflicted`, color: 'error', bold: true }])
  if (git.staged > 0) counts.push([{ text: `${git.staged} staged`, color: 'success' }])
  if (git.modified > 0) counts.push([{ text: `${git.modified} modified`, color: 'warning' }])
  if (git.untracked > 0) counts.push([{ text: `${git.untracked} untracked` }])

  const sync = [
    ...(git.ahead > 0 ? [`${plural(git.ahead, 'commit')} to push`] : []),
    ...(git.behind > 0 ? [`${plural(git.behind, 'commit')} to pull`] : []),
  ]
  const rows: Part[][] = [counts.length === 0 ? [{ text: 'working tree clean', color: 'success' }] : joined(counts)]

  if (sync.length > 0) rows.push(hint(sync.join(' · ')))
  rows.push(hint(`click to copy the ${git.isDetached ? 'commit' : 'branch'}`))

  return {
    title: git.isDetached ? `detached at ${git.branch}` : git.branch,
    aside: counts.length === 0 ? { text: 'clean', color: 'success' } : quiet('uncommitted changes'),
    rows,
  }
}

function legend(parts: readonly ContextPart[]): Part[] {
  return parts.slice(0, 3).flatMap((part, index) => [
    ...(index === 0 ? [] : [{ text: '  ' }]),
    { text: '■ ', color: part.color },
    { text: part.name },
    quiet(` ${tokensFine(part.tokens)}`),
  ])
}

export function fuelCard(reading: Fuel | null, usage: Usage, activity: Activity, palette: Palette): Card {
  if (reading === null || usage.tokens === null) {
    return { title: 'Context', rows: [hint('fills in after the first reply')] }
  }

  const safe = safeLimit(usage.window, usage.isAutoCompact, usage.compactAt)
  const rows: Part[][] = []
  const mix = mixGauge(usage.parts, usage.window, safe, MIX_CELLS, {
    fill: palette.fill,
    track: palette.track,
    reserve: 'warning',
  })

  if (mix.length > 0) rows.push(mix, legend(usage.parts))

  rows.push([
    { text: tokensFine(reading.remaining), bold: true, color: levelColor(reading.level) },
    quiet(` of ${tokensFine(safe)} left `),
    quiet(usage.isAutoCompact ? 'before auto-compact' : '(auto-compact is off)'),
  ])

  const { history } = usage

  // How the fill moved over the last turns, on the scale of the whole tank.
  if (history.length >= 2) {
    rows.push([quiet('fill '), { text: sparkline(history, safe), color: palette.fill }, quiet(`  last ${history.length} turns`)])
  }

  const last = history.length >= 2 ? (history.at(-1) ?? 0) - (history.at(-2) ?? 0) : 0
  const turns = turnsLeft(reading.remaining, history)

  if (last !== 0) {
    rows.push([
      quiet('last turn '),
      { text: `${last > 0 ? '+' : '−'}${tokensFine(Math.abs(last))}` },
      ...(turns === null ? [] : [quiet(` · room for ~${turns} more like it`)]),
    ])
  } else if (activity.lastTurn?.grewBy !== undefined && activity.lastTurn.grewBy !== null && activity.lastTurn.grewBy !== 0) {
    const grew = activity.lastTurn.grewBy

    rows.push([quiet('last turn '), { text: `${grew > 0 ? '+' : '−'}${tokensFine(Math.abs(grew))}` }])
  }

  if (reading.level === 'bad') rows.push(hint('/compact now, or auto-compact steps in soon'))

  return {
    title: 'Context',
    aside: { text: `${reading.percent}% left`, bold: true, color: levelColor(reading.level) },
    rows,
  }
}

export function windowCard(
  id: 'five_hour' | 'seven_day',
  reading: WindowReading,
  now: number,
  palette: Palette,
): Card {
  const title = id === 'five_hour' ? '5-hour limit' : '7-day limit'
  const percent = Math.round(reading.percentUsed)
  const resetsAt = reading.resetsAt === null ? NaN : Date.parse(reading.resetsAt)

  if (Number.isFinite(resetsAt) && resetsAt <= now) {
    return {
      title,
      aside: { ...quiet('reset'), dim: true },
      rows: [
        [quiet('last seen at '), { text: `${percent}%` }, quiet('; it has reset since')],
        hint('the next reply brings a fresh reading'),
      ],
    }
  }

  const level = usageLevel(reading.percentUsed)
  const step = pace(reading.percentUsed, resetsAt, now, WINDOW_SPAN_MS[id])
  const isRunningOut = step !== null && step.runsOutInMs !== null
  const mark = step === null ? undefined : { at: step.elapsed, color: isRunningOut ? 'warning' : 'text', bold: isRunningOut }
  const rows: Part[][] = [
    [
      ...gauge(reading.percentUsed / 100, CARD_GAUGE_CELLS, { fill: fillColor(level, GLYPHS.symbols, palette), track: palette.track }, mark),
      { text: ` ${percent}%`, bold: true, color: levelColor(level) },
      quiet(' used'),
    ],
  ]

  if (step === null) {
    rows.push(hint('too early in the window to call the pace'))
  } else {
    const gone = [{ text: `${Math.round(step.elapsed * 100)}%` }, quiet(' of the window gone')]

    rows.push(
      step.runsOutInMs !== null
        ? [...gone, faint(' · '), { text: `runs out in ${countdown(step.runsOutInMs)} at this pace`, color: 'warning', bold: true }]
        : [...gone, faint(' · '), quiet('at this pace '), { text: `~${Math.min(100, Math.round(step.projected))}%` }, quiet(' by the reset')],
    )
    rows.push(hint('│ marks where an even pace would be by now'))
  }

  return {
    title,
    ...(Number.isFinite(resetsAt) ? { aside: quiet(`resets in ${countdown(resetsAt - now)}`) } : {}),
    rows,
  }
}

export function cacheCard(cache: CacheState, now: number): Card {
  const left = cacheLeft(cache, now) ?? 0
  const ttl = cache.ttlMs >= TTL_1H ? 'an hour' : '5 minutes'
  const rows: Part[][] = [
    [quiet('an entry lives '), { text: ttl }, quiet(' unread'), ...(cache.isTtlKnown ? [] : [quiet(' (assumed)')])],
  ]
  const since = cache.lastRequestAt === null ? null : now - cache.lastRequestAt

  if (since !== null) {
    rows.push([
      quiet('last request '),
      { text: ago(since) },
      ...(cache.hitRatio === null
        ? []
        : [faint(' · '), { text: `${Math.round(cache.hitRatio * 100)}%` }, quiet(' of it read from the cache')]),
    ])
  }

  const size = cache.tokens === null ? null : tokensFine(cache.tokens)

  if (left <= 0) {
    const isCostly = (cache.tokens ?? 0) >= COLD_MATTERS_TOKENS

    rows.push(
      size === null
        ? hint('the next message writes the context to the cache again')
        : [
            quiet('the next message writes '),
            { text: `~${size}`, color: isCostly ? 'warning' : undefined, bold: isCostly },
            quiet(' to the cache again'),
          ],
    )
  } else {
    rows.push([
      quiet('reply within '),
      { text: timeLeft(left) ?? '' },
      quiet(` and ${size === null ? 'it' : size} reads back at 1/10 the price`),
    ])
  }

  return {
    title: 'Prompt cache',
    aside: left > 0 ? { text: `${timeLeft(left) ?? ''} left` } : { text: 'cold', color: 'warning' },
    rows,
  }
}

export function tallyCard(activity: Activity): Card {
  const rows: Part[][] = []

  for (const run of activity.running) rows.push([{ text: '» ', color: 'claude', bold: true }, { text: phrase(run.tool, run.target) }])

  // Four to a row: a turn of many tools still makes a small card.
  for (let index = 0; index < activity.tally.length; index += 4) {
    rows.push(
      joined(
        activity.tally.slice(index, index + 4).map(one => [
          { text: one.tool },
          quiet(` ×${one.count}`),
          ...(one.errors > 0 ? [{ text: ` ${one.errors} failed`, color: 'error' }] : []),
        ]),
      ),
    )
  }

  if (rows.length === 0) rows.push(hint('no tools yet this turn'))

  const total = activity.tally.reduce((sum, one) => sum + one.count, 0)

  return { title: 'This turn', aside: quiet(plural(total, 'tool')), rows }
}

/** How an agent stands, in one cell: running, done, failed, or stopped. */
export function agentMark(agent: AgentRun, palette: Palette): Part {
  switch (agent.status) {
    case 'running':
      return { text: '■', color: palette.fill }
    case 'done':
      return { text: '✓', color: 'success' }
    case 'failed':
      return { text: '!', color: 'error', bold: true }
    case 'stopped':
      return quiet('·')
  }
}

function agentRow(agent: AgentRun, now: number, palette: Palette): Part[][] {
  const took = elapsed((agent.endedAt ?? now) - agent.startedAt)
  const rows: Part[][] = [
    [
      agentMark(agent, palette),
      { text: ` ${agent.type}`, bold: agent.status === 'running' },
      quiet(`  ${took}`),
      ...(agent.tools > 0 ? [quiet(` · ${plural(agent.tools, 'tool')}`)] : []),
      ...(agent.isBackground ? [quiet(' · in the background')] : []),
      ...(agent.status === 'stopped' ? [{ text: ' · interrupted', color: 'warning' }] : []),
      ...(agent.status === 'failed' ? [{ text: ' · failed', color: 'error' }] : []),
    ],
  ]

  if (agent.description !== '') rows.push([quiet(`  ${clip(agent.description, 56)}`)])
  if (agent.doing !== null) rows.push([{ text: '  » ', color: palette.accent }, quiet(clip(agent.doing, 52))])

  return rows
}

export function agentsCard(activity: Activity, now: number, palette: Palette): Card {
  const running = activity.agents.filter(one => one.status === 'running').length

  return {
    title: 'Agents',
    aside: running > 0 ? { text: `${running} running`, color: palette.fill } : quiet('all done'),
    rows: activity.agents.flatMap(agent => agentRow(agent, now, palette)),
  }
}

export function tasksCard(tasks: readonly TaskItem[]): Card {
  const { done, total } = progress(tasks)
  const shown = tasks.slice(0, LIST_ROWS)
  const rows: Part[][] = shown.map(task => {
    if (task.status === 'completed') return [{ text: '✓ ', color: 'success' }, quiet(task.subject)]
    if (task.status === 'in_progress') {
      return [{ text: '» ', color: 'claude', bold: true }, { text: task.activeForm ?? task.subject, bold: true }]
    }

    return [faint('· '), { text: task.subject }]
  })

  if (tasks.length > shown.length) rows.push(hint(`+${tasks.length - shown.length} more`))

  return {
    title: 'Tasks',
    aside: done === total ? { text: `✓ ${done}/${total}`, color: 'success' } : { text: `${done}/${total}` },
    rows,
  }
}
