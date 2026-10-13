// The cards behind the segments: what a glance at the band leaves out. A
// title, then a few rows, the last one saying what a click does where a
// click does something.

import type { ContextPart, GitInfo, Identity, Usage, WindowReading } from '../../types'
import {
  countdown,
  effortStyle,
  pace,
  prettyModel,
  safeLimit,
  tokensFine,
  turnsLeft,
  usageLevel,
  width,
  type Fuel,
} from './format'
import { faint, levelColor, plural, quiet, type Card, type Part } from './style'

export const WINDOW_SPAN_MS = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}

const hint = (text: string): Part[] => [quiet(text)]
const NAME_ROW = hint('other sessions message this one by this name')

export function modelCard(identity: Identity): Card {
  const rows: Part[][] = [[quiet(identity.model)]]

  if (identity.effort !== null) {
    const style = effortStyle(identity.effort)

    rows.push([
      quiet('effort '),
      ...(style.rank > 0
        ? [{ text: style.lit, color: 'claude' }, faint(style.unlit), { text: ' ' }]
        : []),
      { text: identity.effort, bold: true },
      ...(style.rank > 0 ? [quiet(`  ${style.rank} of 5`)] : []),
    ])
  }

  rows.push(hint('click to copy the model id'))

  return { title: prettyModel(identity.model), rows }
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
  const counts: Part[] = []

  if (git.conflicted > 0) counts.push({ text: `${git.conflicted} conflicted`, color: 'error' })
  if (git.staged > 0) counts.push({ text: `${git.staged} staged`, color: 'success' })
  if (git.modified > 0) counts.push({ text: `${git.modified} modified`, color: 'warning' })
  if (git.untracked > 0) counts.push({ text: `${git.untracked} untracked` })

  const sync = [
    ...(git.ahead > 0 ? [`${plural(git.ahead, 'commit')} to push`] : []),
    ...(git.behind > 0 ? [`${plural(git.behind, 'commit')} to pull`] : []),
  ]
  const rows: Part[][] = [
    counts.length === 0
      ? [{ text: 'working tree clean', color: 'success' }]
      : counts.flatMap((part, index) => (index === 0 ? [part] : [faint(' · '), part])),
  ]

  if (sync.length > 0) rows.push(hint(sync.join(' · ')))
  rows.push(hint(`click to copy the ${git.isDetached ? 'commit' : 'branch'}`))

  return { title: git.isDetached ? `detached at ${git.branch}` : git.branch, rows }
}

/** The context's mix as one track: each kind in its own colour, then the free room, then the reserve. */
function mixTrack(usage: Usage, safe: number, cells: number): Part[] {
  if (usage.parts.length === 0 || usage.window <= 0) return []

  const cell = usage.window / cells
  const out: Part[] = []
  let used = 0

  for (const part of usage.parts) {
    // Every kind that holds anything gets a cell, so none vanishes at a glance.
    const count = Math.max(1, Math.round(part.tokens / cell))
    const room = Math.min(count, cells - used)

    if (room > 0) out.push({ text: '━'.repeat(room), color: part.color })
    used += room
  }

  const reserve = Math.max(0, Math.min(cells - used, Math.round((usage.window - safe) / cell)))
  const free = Math.max(0, cells - used - reserve)

  if (free > 0) out.push(faint('─'.repeat(free)))
  if (reserve > 0) out.push({ text: '╌'.repeat(reserve), color: 'warning', dim: true })

  return out
}

function legend(parts: readonly ContextPart[]): Part[] {
  return parts.slice(0, 3).flatMap((part, index) => [
    ...(index === 0 ? [] : [{ text: '  ' }]),
    { text: '■ ', color: part.color },
    { text: part.name },
    quiet(` ${tokensFine(part.tokens)}`),
  ])
}

export function fuelCard(reading: Fuel | null, usage: Usage): Card {
  if (reading === null || usage.tokens === null) {
    return { title: 'Context', rows: [hint('fills in after the first reply')] }
  }

  const safe = safeLimit(usage.window, usage.isAutoCompact, usage.compactAt)
  const rows: Part[][] = [
    [
      { text: tokensFine(reading.remaining), bold: true, color: levelColor(reading.level) },
      quiet(` of ${tokensFine(safe)} left `),
      quiet(usage.isAutoCompact ? 'before auto-compact' : '(auto-compact is off)'),
    ],
  ]
  const key = legend(usage.parts)
  // As wide as the legend beneath it, so the two read as one figure.
  const mix = mixTrack(usage, safe, Math.max(32, Math.min(56, width(key.map(part => part.text).join('')))))

  if (mix.length > 0) rows.push(mix, key)

  const { history } = usage
  const last = history.length >= 2 ? (history.at(-1) ?? 0) - (history.at(-2) ?? 0) : 0
  const turns = turnsLeft(reading.remaining, history)

  if (last !== 0) {
    rows.push([
      quiet('last turn '),
      { text: `${last > 0 ? '+' : '−'}${tokensFine(Math.abs(last))}` },
      ...(turns === null ? [] : [quiet(` · room for ~${turns} more like it`)]),
    ])
  }

  if (reading.level === 'bad') rows.push(hint('/compact now, or auto-compact steps in soon'))

  return { title: `Context · ${reading.percent}% left`, rows }
}

export function windowCard(
  id: 'five_hour' | 'seven_day',
  reading: WindowReading,
  now: number,
): Card {
  const title = id === 'five_hour' ? '5-hour limit' : '7-day limit'
  const percent = Math.round(reading.percentUsed)
  const resetsAt = reading.resetsAt === null ? NaN : Date.parse(reading.resetsAt)

  if (Number.isFinite(resetsAt) && resetsAt <= now) {
    return {
      title,
      rows: [
        [quiet('last seen at '), { text: `${percent}%` }, quiet('; it has reset since')],
        hint('the next reply brings a fresh reading'),
      ],
    }
  }

  const step = pace(reading.percentUsed, resetsAt, now, WINDOW_SPAN_MS[id])
  const rows: Part[][] = [
    [
      { text: `${percent}%`, bold: true, color: levelColor(usageLevel(reading.percentUsed)) },
      quiet(' used'),
      ...(step === null
        ? []
        : [faint(' · '), { text: `${Math.round(step.elapsed * 100)}%` }, quiet(' of the window gone')]),
    ],
  ]

  if (step === null) {
    rows.push(hint('too early in the window to call the pace'))
  } else if (step.runsOutInMs !== null) {
    rows.push([
      { text: `at this pace it runs out in ${countdown(step.runsOutInMs)}`, color: 'warning' },
      quiet(`, ${countdown(step.resetsInMs - step.runsOutInMs)} before the reset`),
    ])
  } else {
    rows.push([
      quiet('at this pace: '),
      { text: `~${Math.min(100, Math.round(step.projected))}%` },
      quiet(' by the reset'),
    ])
  }

  if (Number.isFinite(resetsAt)) rows.push([quiet('resets in '), { text: countdown(resetsAt - now) }])
  if (step !== null) rows.push(hint('│ on the bar marks an even pace for now'))

  return { title, rows }
}
