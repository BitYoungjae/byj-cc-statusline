// The band's segments, built from the session's figures at one level of
// detail. Every part carries its own spaces, so a segment's width is the sum
// of its parts' and the arranger can choose a layout before anything draws.

import type { GitInfo, Identity, Usage, WindowReading } from '../../types'
import { fuelCard, gitCard, modelCard, placeCard, tagCard, windowCard, WINDOW_SPAN_MS } from './cards'
import {
  clip,
  countdown,
  dollars,
  effortStyle,
  fuel,
  pace,
  prettyModel,
  tokens,
  track,
  usageLevel,
  type Fuel,
} from './format'
import { isClean } from './git'
import { placeName } from './session-name'
import {
  faint,
  fillColor,
  GLYPHS,
  levelColor,
  quiet,
  type Detail,
  type Frame,
  type Glyphs,
  type Part,
  type Seg,
  type Settings,
} from './style'

function modelSeg(identity: Identity, glyphs: Glyphs, detail: Detail): Seg | null {
  if (identity.model === '') return null

  // The id as the engine names it, which is what a flag or a config takes.
  const copy = { id: 'model', text: identity.model }
  const parts: Part[] = [
    ...(glyphs.model === '' ? [] : [{ text: glyphs.model, copy }]),
    { text: prettyModel(identity.model), color: 'claude', bold: true, copy },
  ]

  if (identity.effort !== null) {
    const style = effortStyle(identity.effort)
    const word: Part = { text: identity.effort, color: 'inactive', bold: style.rank === 5 }

    parts.push({ text: ' ' })

    if (!glyphs.isModern) {
      parts.push({ text: glyphs.effort }, { text: identity.effort })
    } else {
      // The meter is the first thing a narrow band gives up; the word stays.
      if (detail < 2 && style.rank > 0) {
        parts.push({ text: style.lit, color: 'claude' })
        if (style.unlit !== '') parts.push(faint(style.unlit))
        parts.push({ text: ' ' })
      }

      parts.push(word)
    }
  }

  return { id: 'model', row: 'context', priority: 0, parts, card: modelCard(identity) }
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
      { text: clip(place, detail === 2 ? 24 : 40), copy },
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
    {
      text: clip(name, detail === 0 ? 32 : detail === 1 ? 24 : 16),
      color: glyphs.isModern ? undefined : 'merged',
      copy,
    },
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

  if (git.ahead > 0) parts.push({ text: ` ↑${git.ahead}` })
  if (git.behind > 0) parts.push({ text: ` ↓${git.behind}` })

  return { id: 'git', row: 'context', priority: 2, parts, card: gitCard(git) }
}

function fuelSeg(
  reading: Fuel | null,
  usage: Usage,
  detail: Detail,
  glyphs: Glyphs,
  canCompact: boolean,
): Seg {
  const cells = detail === 0 ? 10 : detail === 1 ? 6 : 0
  const level = reading?.level ?? 'good'
  const isLow = level === 'bad'
  const isChip = isLow && glyphs.isModern
  const parts: Part[] = [
    isLow ? { text: glyphs.fuelLow, color: 'error' } : quiet(glyphs.fuel),
  ]

  if (cells > 0) {
    for (const run of track((reading?.percent ?? 0) / 100, cells)) {
      parts.push(run.kind === 'fill' ? { text: run.text, color: fillColor(level, glyphs) } : faint(run.text))
    }

    // The chip brings its own space.
    if (!isChip) parts.push({ text: ' ' })
  }

  if (reading === null) {
    // No response yet means no reading: a dash, not a made-up full tank.
    parts.push(quiet('–'))
  } else if (isChip) {
    // Past the point of colour alone: the number itself is lit.
    parts.push({ text: ` ${reading.percent}% `, color: 'inverseText', bg: 'error', bold: true })
  } else {
    parts.push({ text: `${reading.percent}%`, color: levelColor(level, glyphs) })
  }

  if (reading !== null && detail < 2) {
    parts.push(quiet(detail === 0 ? ` ${tokens(reading.remaining)} left` : ` ${tokens(reading.remaining)}`))
  }

  // Low on fuel is when a way out helps: one press puts /compact in the
  // prompt. It is offered, never run: compacting is the person's call.
  if (isLow && canCompact && detail < 2) {
    parts.push({ text: ' ' })
    parts.push({ text: '/compact', color: 'error', bold: true, underline: true, press: 'compact' })
  }

  return { id: 'fuel', row: 'metrics', priority: 1, parts, card: fuelCard(reading, usage) }
}

function windowSeg(
  id: 'five_hour' | 'seven_day',
  reading: WindowReading,
  now: number,
  detail: Detail,
  glyphs: Glyphs,
): Seg {
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
    const markAt = glyphs.isModern && step !== null ? step.elapsed : undefined
    const isRunningOut = step !== null && step.runsOutInMs !== null

    for (const run of track(reading.percentUsed / 100, cells, markAt)) {
      if (run.kind === 'rest') parts.push(faint(run.text))
      else if (run.kind === 'mark') parts.push(isRunningOut ? { text: run.text, color: 'warning', bold: true } : quiet(run.text))
      else if (isStale) parts.push({ ...faint(run.text), dim: true })
      else parts.push({ text: run.text, color: fillColor(level, glyphs) })
    }

    parts.push({ text: ' ' })
  }

  parts.push(
    isStale
      ? { ...quiet(`~${percent}%`), dim: true }
      : { text: `${percent}%`, color: levelColor(level, glyphs), bold: level === 'bad' },
  )

  if (detail === 0 && !isStale && Number.isFinite(resetsAt)) {
    parts.push(quiet(` (${countdown(resetsAt - now)})`))
  }

  return {
    id,
    row: 'metrics',
    priority: id === 'five_hour' ? 3 : 5,
    parts,
    card: windowCard(id, reading, now),
  }
}

function costSeg(usage: Usage, settings: Settings): Seg | null {
  if (!settings.showCost || usage.costUsd === null) return null

  return { id: 'cost', row: 'metrics', priority: 6, parts: [quiet(dollars(usage.costUsd))] }
}

/** Every segment the figures call for, at one level of detail. */
export function build(frame: Frame, settings: Settings, detail: Detail): Seg[] {
  const glyphs = GLYPHS[settings.icons]
  const { place, tag } = placeName(frame.identity.dir, frame.identity.sessionName)
  const { usage } = frame
  const reading = fuel(usage.tokens, usage.window, usage.isAutoCompact, usage.compactAt)
  const { five_hour: fiveHour, seven_day: sevenDay } = usage.windows

  const segs = [
    modelSeg(frame.identity, glyphs, detail),
    placeSeg(frame.identity, place, glyphs, detail),
    tagSeg(tag, glyphs),
    gitSeg(frame.git, glyphs, detail),
    // Without a first response there is nothing to measure yet, but the gauge
    // holds its place so the band does not jump when the reading arrives.
    fuelSeg(reading, usage, detail, glyphs, !frame.isWorking),
    fiveHour === null ? null : windowSeg('five_hour', fiveHour, frame.now, detail, glyphs),
    sevenDay === null ? null : windowSeg('seven_day', sevenDay, frame.now, detail, glyphs),
    costSeg(usage, settings),
  ]

  return segs.filter((seg): seg is Seg => seg !== null)
}
