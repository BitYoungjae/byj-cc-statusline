// The band's segments, built from the session's figures at one level of
// detail. Every part carries its own spaces, so a segment's width is the sum
// of its parts' and the arranger can choose a layout before anything draws.
// Figures that change (a percentage, a countdown) are padded to the width
// their widest takes, so a line holds still as they move.

import type { Activity, AgentRun, CacheState, GitInfo, Identity, Usage, WindowReading } from '../../types'
import { hasRunningAgents, isLive, progress, toolName } from './activity'
import { cacheLeft, COLD_MATTERS_TOKENS } from './cache'
import {
  agentMark,
  agentsCard,
  cacheCard,
  fuelCard,
  gitCard,
  modelCard,
  placeCard,
  tagCard,
  tallyCard,
  tasksCard,
  WINDOW_SPAN_MS,
  windowCard,
} from './cards'
import {
  clip,
  countdown,
  dollars,
  effortStyle,
  elapsed,
  fuel,
  pace,
  pad,
  padEnd,
  prettyModel,
  timeLeft,
  tokens,
  usageLevel,
  type Fuel,
} from './format'
import { gauge } from './gauge'
import { isClean } from './git'
import { placeName } from './session-name'
import {
  faint,
  fillColor,
  GLYPHS,
  levelColor,
  paletteOf,
  plural,
  quiet,
  type Detail,
  type Frame,
  type Glyphs,
  type Palette,
  type Part,
  type Seg,
  type Settings,
} from './style'

type Look = { glyphs: Glyphs; palette: Palette }

/**
 * A gauge's figure: after the gauge, a space and the four cells the widest
 * takes (` 66%`, `100%`), so the line holds still as it moves; with no gauge,
 * straight after the label.
 */
function figure(text: string, cells: number): string {
  return cells > 0 ? ` ${pad(text, 4)}` : text
}

function modelSeg(identity: Identity, look: Look, detail: Detail, frame: Frame): Seg | null {
  if (identity.model === '') return null

  const { glyphs, palette } = look
  // The id as the engine names it, which is what a flag or a config takes.
  const copy = { id: 'model', text: identity.model }
  const name = prettyModel(identity.model)
  const parts: Part[] = glyphs.isModern
    ? // The badge the band starts with: the model on the background a prompt has.
      [{ text: ` ${name} `, color: palette.accent, bg: palette.badge, bold: true, copy }]
    : [
        { text: glyphs.model, copy },
        { text: name, color: 'claude', bold: true, copy },
      ]

  if (identity.effort !== null) {
    const style = effortStyle(identity.effort)
    const isMax = style.rank === 5

    parts.push({ text: ' ' })

    if (!glyphs.isModern) {
      parts.push({ text: glyphs.effort }, { text: identity.effort })
    } else {
      // The meter is the first thing a narrow band gives up; the word stays.
      if (detail < 2 && style.rank > 0) {
        parts.push({ text: style.lit, color: isMax ? palette.ultra : palette.accent })
        if (style.unlit !== '') parts.push(faint(style.unlit))
        parts.push({ text: ' ' })
      }

      parts.push(
        isMax ? { text: identity.effort, color: palette.ultra, bold: true } : quiet(identity.effort),
      )
    }
  }

  return {
    id: 'model',
    row: 'context',
    priority: 0,
    parts,
    card: modelCard(identity, frame.activity.lastTurn, palette),
  }
}

function placeSeg(identity: Identity, place: string, glyphs: Glyphs, detail: Detail): Seg | null {
  if (place === '') return null

  const isName = place !== identity.dir
  // A derived name is the address peers use; a bare directory copies whole.
  const copy = { id: 'place', text: isName ? place : identity.cwd || place }

  return {
    id: 'place',
    row: 'context',
    priority: 0,
    parts: [
      ...(glyphs.place === '' ? [] : [{ text: glyphs.place, copy }]),
      { text: clip(place, detail === 2 ? 24 : 40), bold: glyphs.isModern, copy },
    ],
    card: placeCard(identity, place, isName),
  }
}

function tagSeg(tag: string | null, glyphs: Glyphs): Seg | null {
  if (tag === null) return null

  const copy = { id: 'tag', text: tag }

  return {
    id: 'tag',
    row: 'context',
    priority: 4,
    parts: [
      { text: glyphs.tag, color: glyphs.isModern ? 'inactive' : undefined, copy },
      { text: clip(tag, 32), color: glyphs.isModern ? undefined : 'remember', copy },
    ],
    card: tagCard(tag),
  }
}

function gitSeg(git: GitInfo | null, glyphs: Glyphs, detail: Detail): Seg | null {
  if (git === null) return null

  const copy = { id: 'branch', text: git.branch }
  const name = git.isDetached ? `@${git.branch}` : git.branch
  const parts: Part[] = [
    ...(glyphs.branch === '' ? [] : [{ text: glyphs.branch, copy }]),
    { text: clip(name, detail === 0 ? 32 : detail === 1 ? 24 : 16), color: 'merged', copy },
  ]

  if (isClean(git)) {
    parts.push({ text: ' ✓', color: 'success' })
  } else {
    // Counts with a sign each, so the kinds read without their colour.
    if (git.conflicted > 0) parts.push({ text: ` !${git.conflicted}`, color: 'error', bold: true })
    if (git.staged > 0) parts.push({ text: ` +${git.staged}`, color: 'success' })
    if (git.modified > 0) parts.push({ text: ` ~${git.modified}`, color: 'warning' })
    if (git.untracked > 0) parts.push(quiet(` ?${git.untracked}`))
  }

  if (git.ahead > 0) parts.push(quiet(` ↑${git.ahead}`))
  if (git.behind > 0) parts.push(quiet(` ↓${git.behind}`))

  return { id: 'git', row: 'context', priority: 2, parts, card: gitCard(git) }
}

function fuelSeg(reading: Fuel | null, usage: Usage, detail: Detail, look: Look, canCompact: boolean, frame: Frame): Seg {
  const { glyphs, palette } = look
  const cells = detail === 0 ? 10 : detail === 1 ? 6 : 0
  const level = reading?.level ?? 'good'
  const isLow = level === 'bad'
  const parts: Part[] = [isLow ? { text: glyphs.fuelLow, color: 'error' } : quiet(glyphs.fuel)]

  if (cells > 0) {
    parts.push(...gauge((reading?.percent ?? 0) / 100, cells, { fill: fillColor(level, glyphs, palette), track: palette.track }))
  }

  if (reading === null) {
    // No response yet means no reading: a dash, not a made-up full tank.
    parts.push(quiet(figure('−', cells)))
  } else if (isLow && glyphs.isModern) {
    // Past the point of colour alone: the number itself is lit.
    if (cells > 0) parts.push({ text: ' ' })
    parts.push({ text: ` ${reading.percent}% `, color: 'inverseText', bg: 'error', bold: true })
  } else {
    parts.push({ text: figure(`${reading.percent}%`, cells), color: levelColor(level, glyphs) })
  }

  if (reading !== null && detail < 2) {
    parts.push(quiet(` ${padEnd(`${tokens(reading.remaining)}${detail === 0 ? ' left' : ''}`, detail === 0 ? 9 : 4)}`))
  }

  // Low on fuel is when a way out helps: one press puts /compact in the
  // prompt. It is offered, never run: compacting is the person's call.
  if (isLow && canCompact && detail < 2) {
    parts.push({ text: ' ' })
    parts.push({ text: '/compact', color: 'error', bold: true, underline: true, press: 'compact' })
  }

  return { id: 'fuel', row: 'metrics', priority: 1, parts, card: fuelCard(reading, usage, frame.activity, palette) }
}

function windowSeg(
  id: 'five_hour' | 'seven_day',
  reading: WindowReading,
  now: number,
  detail: Detail,
  look: Look,
): Seg {
  const { glyphs, palette } = look
  const resetsAt = reading.resetsAt === null ? NaN : Date.parse(reading.resetsAt)
  // Only a remembered reading can be past its reset: a live one is dropped by
  // Claude Code the moment its window ends. Shown dimmed and marked `~`.
  const isStale = Number.isFinite(resetsAt) && resetsAt <= now
  const percent = Math.round(reading.percentUsed)
  const level = usageLevel(reading.percentUsed)
  const step = isStale ? null : pace(reading.percentUsed, resetsAt, now, WINDOW_SPAN_MS[id])
  const cells = detail === 0 ? 8 : detail === 1 ? 5 : 0
  const parts: Part[] = []

  // The emoji look marks the pair of windows once, on the first.
  if (id === 'five_hour' && glyphs.usage !== '') parts.push({ text: glyphs.usage })

  parts.push(quiet(id === 'five_hour' ? '5h ' : '7d '))

  if (cells > 0) {
    // The mark is where an even pace would have the fill by now; it lights
    // up when that pace held would run the window out before it resets.
    const isRunningOut = step !== null && step.runsOutInMs !== null
    const mark =
      glyphs.isModern && step !== null
        ? { at: step.elapsed, color: isRunningOut ? 'warning' : 'text', ...(isRunningOut ? { bold: true } : {}) }
        : undefined
    const fill = isStale ? 'subtle' : fillColor(level, glyphs, palette)

    parts.push(...gauge(reading.percentUsed / 100, cells, { fill, track: palette.track }, mark))
  }

  parts.push(
    isStale
      ? { ...quiet(figure(`~${percent}%`, cells)), dim: true }
      : { text: figure(`${percent}%`, cells), color: levelColor(level, glyphs), bold: level === 'bad' },
  )

  if (detail === 0 && !isStale && Number.isFinite(resetsAt)) {
    parts.push(quiet(` ${padEnd(countdown(resetsAt - now), 5)}`))
  }

  return {
    id,
    row: 'metrics',
    priority: id === 'five_hour' ? 3 : 5,
    parts,
    card: windowCard(id, reading, now, palette),
  }
}

/**
 * The prompt cache between turns: how long until the entry the last request
 * refreshed lapses, ticking on the surface, then `cold`. While a turn runs
 * every request refreshes it, so there is nothing to count.
 */
function cacheSeg(cache: CacheState, frame: Frame, glyphs: Glyphs, settings: Settings): Seg | null {
  if (!settings.hasCache || frame.isWorking) return null

  const left = cacheLeft(cache, frame.now)

  if (left === null) return null

  const coldColor = (cache.tokens ?? 0) >= COLD_MATTERS_TOKENS ? 'warning' : 'inactive'
  const clockPart: Part =
    left > 0
      ? {
          text: padEnd(timeLeft(left) ?? 'cold', 4),
          live: {
            kind: 'clock',
            ms: left,
            direction: 'down',
            soonMs: 60_000,
            soonColor: 'warning',
            doneText: 'cold',
            doneColor: coldColor,
            width: 4,
          },
        }
      : { text: 'cold', color: coldColor }

  return {
    id: 'cache',
    row: 'metrics',
    priority: 6,
    parts: [quiet(glyphs.cache), clockPart],
    card: cacheCard(cache, frame.now),
  }
}

function costSeg(usage: Usage, settings: Settings): Seg | null {
  if (!settings.showCost || usage.costUsd === null) return null

  return { id: 'cost', row: 'metrics', priority: 7, parts: [quiet(dollars(usage.costUsd))] }
}

// ── the activity line ──

/** What the main loop is doing this moment: the newest tool in flight, else thinking. */
function nowSeg(activity: Activity, glyphs: Glyphs, palette: Palette, detail: Detail): Seg {
  const newest = activity.running[activity.running.length - 1]
  const parts: Part[] = [{ text: '▖', live: { kind: 'spinner', color: palette.accent } }, { text: ' ' }]

  if (newest === undefined) {
    parts.push(quiet('thinking'))
  } else {
    parts.push({ text: toolName(newest.tool), bold: true })

    if (newest.target !== '' && detail < 2) parts.push(quiet(` ${clip(newest.target, detail === 0 ? 32 : 20)}`))
    if (activity.running.length > 1) parts.push(quiet(` +${activity.running.length - 1}`))
  }

  if (!glyphs.isModern) parts.unshift({ text: glyphs.tools })

  return { id: 'now', row: 'activity', priority: 0, parts, card: tallyCard(activity) }
}

/** The running turn's finished tools by name: `Read ×4  Grep ×2`. */
function tallySeg(activity: Activity, detail: Detail): Seg | null {
  if (activity.tally.length === 0) return null

  const parts: Part[] = []

  if (detail === 2) {
    const total = activity.tally.reduce((sum, one) => sum + one.count, 0)

    parts.push(quiet(plural(total, 'tool')))
  } else {
    const shown = activity.tally.slice(0, detail === 0 ? 4 : 2)

    for (const [index, one] of shown.entries()) {
      if (index > 0) parts.push({ text: '  ' })
      parts.push({ text: one.tool }, quiet(` ×${one.count}`))
      if (one.errors > 0) parts.push({ text: '!', color: 'error', bold: true })
    }

    if (activity.tally.length > shown.length) parts.push(quiet(`  +${activity.tally.length - shown.length}`))
  }

  return { id: 'tally', row: 'activity', priority: 3, parts, card: tallyCard(activity) }
}

/** One agent: its mark, its type, and its clock, live while it runs. */
function agentParts(agent: AgentRun, now: number, palette: Palette, hasDescription: boolean): Part[] {
  const parts: Part[] = [agentMark(agent, palette), { text: ` ${clip(agent.type, 20)}`, bold: agent.status === 'running' }]

  if (hasDescription && agent.description !== '') parts.push(quiet(` ${clip(agent.description, 28)}`))

  const ms = (agent.endedAt ?? now) - agent.startedAt
  const shown = elapsed(ms)

  parts.push({ text: ' ' })
  parts.push(
    agent.status === 'running'
      ? { text: padEnd(shown, 5), color: 'inactive', live: { kind: 'clock', ms, direction: 'up', color: 'inactive', width: 5 } }
      : quiet(shown),
  )

  return parts
}

function agentsSeg(activity: Activity, now: number, glyphs: Glyphs, palette: Palette, detail: Detail): Seg | null {
  const { agents } = activity

  if (agents.length === 0) return null

  const parts: Part[] = glyphs.isModern ? [] : [{ text: glyphs.agents }]
  const running = agents.filter(one => one.status === 'running').length

  if (detail === 2) {
    parts.push({ text: '■', color: palette.fill }, { text: ` ${plural(agents.length, 'agent')}` })
    if (running > 0 && running < agents.length) parts.push(quiet(` ${running} running`))
  } else {
    const shown = agents.slice(0, detail === 0 ? 2 : 1)

    for (const [index, agent] of shown.entries()) {
      if (index > 0) parts.push(faint('  '))
      parts.push(...agentParts(agent, now, palette, agents.length === 1 && detail === 0))
    }

    if (agents.length > shown.length) parts.push(quiet(`  +${agents.length - shown.length}`))
  }

  return {
    id: 'agents',
    row: 'activity',
    // While one still runs it is what the line is for; finished, the first to go.
    priority: hasRunningAgents(activity) ? 1 : 4,
    parts,
    card: agentsCard(activity, now, palette),
  }
}

function tasksSeg(activity: Activity, glyphs: Glyphs, palette: Palette, detail: Detail): Seg | null {
  const { done, total, current } = progress(activity.tasks)

  if (total === 0) return null

  const isDone = done === total
  const parts: Part[] = [quiet(glyphs.tasks)]

  if (detail < 2) {
    parts.push(...gauge(done / total, detail === 0 ? 6 : 4, { fill: isDone ? 'success' : palette.fill, track: palette.track }))
    parts.push({ text: ' ' })
  }

  parts.push(isDone ? { text: `✓ ${done}/${total}`, color: 'success' } : { text: `${done}/${total}` })

  if (!isDone && current !== null && detail === 0) {
    parts.push(quiet(` ${clip(current.status === 'in_progress' ? current.activeForm ?? current.subject : current.subject, 36)}`))
  }

  return { id: 'tasks', row: 'activity', priority: 2, parts, card: tasksCard(activity.tasks) }
}

function activitySegs(frame: Frame, settings: Settings, look: Look, detail: Detail): (Seg | null)[] {
  const { activity, isWorking, now } = frame

  if (!settings.hasActivity || !isLive(activity, isWorking)) return []

  return [
    isWorking ? nowSeg(activity, look.glyphs, look.palette, detail) : null,
    agentsSeg(activity, now, look.glyphs, look.palette, detail),
    // Between turns a task list shows only while one of it is under way.
    isWorking || activity.tasks.some(one => one.status === 'in_progress')
      ? tasksSeg(activity, look.glyphs, look.palette, detail)
      : null,
    isWorking ? tallySeg(activity, detail) : null,
  ]
}

/** Every segment the figures call for, at one level of detail. */
export function build(frame: Frame, settings: Settings, detail: Detail): Seg[] {
  const look: Look = { glyphs: GLYPHS[settings.icons], palette: paletteOf(frame.isTerminal) }
  const { place, tag } = placeName(frame.identity.dir, frame.identity.sessionName)
  const { usage } = frame
  const reading = fuel(usage.tokens, usage.window, usage.isAutoCompact, usage.compactAt)
  const { five_hour: fiveHour, seven_day: sevenDay } = usage.windows

  const segs = [
    modelSeg(frame.identity, look, detail, frame),
    placeSeg(frame.identity, place, look.glyphs, detail),
    tagSeg(tag, look.glyphs),
    gitSeg(frame.git, look.glyphs, detail),
    // Without a first response there is nothing to measure yet, but the gauge
    // holds its place so the band does not jump when the reading arrives.
    fuelSeg(reading, usage, detail, look, !frame.isWorking, frame),
    fiveHour === null ? null : windowSeg('five_hour', fiveHour, frame.now, detail, look),
    sevenDay === null ? null : windowSeg('seven_day', sevenDay, frame.now, detail, look),
    cacheSeg(frame.cache, frame, look.glyphs, settings),
    costSeg(usage, settings),
    ...activitySegs(frame, settings, look, detail),
  ]

  return segs.filter((seg): seg is Seg => seg !== null)
}
