// A clock that ticks on the surface's own frame clock, so the band need not
// redraw every second: a countdown (the prompt cache) or a running time (a
// subagent). The hooks module hands it the time as of its drawing; between
// drawings it counts on by itself, and each new drawing sets it right again.

import type { ClientModule } from 'claude-code'

import { elapsed, padEnd, timeLeft } from '../lib/format'

export type ClockProps = {
  /** The time on the clock as the band drew it, in ms: left (`down`) or gone (`up`). */
  ms: number
  direction: 'up' | 'down'
  color?: string
  soonMs?: number
  soonColor?: string
  doneText?: string
  doneColor?: string
  /** Cells it always takes, padded on the right, so the line never shifts. */
  width: number
}

type Local = {
  /** The props of the latest drawing: the tick reads these, never the first call's. */
  props: ClockProps
  seconds: number
  stop: (() => void) | null
}

// Per instance: the surface object is the same on every call while it lives.
const locals = new WeakMap<object, Local>()

function clockFace(props: ClockProps, seconds: number): { text: string; color?: string } {
  const ms = props.ms + (props.direction === 'up' ? 1 : -1) * seconds * 1000

  if (props.direction === 'up') {
    return { text: padEnd(elapsed(ms), props.width), ...(props.color === undefined ? {} : { color: props.color }) }
  }

  const left = timeLeft(ms)

  if (left === null) {
    const done = props.doneText ?? '0:00'

    return { text: padEnd(done, props.width), ...(props.doneColor === undefined ? {} : { color: props.doneColor }) }
  }

  const color = props.soonMs !== undefined && ms <= props.soonMs ? props.soonColor : props.color

  return { text: padEnd(left, props.width), ...(color === undefined ? {} : { color }) }
}

const Clock: ClientModule<ClockProps, number> = (props, surface) => {
  let local = locals.get(surface)

  if (local === undefined) {
    local = { props, seconds: 0, stop: null }
    locals.set(surface, local)
  } else if (local.props.ms !== props.ms || local.props.direction !== props.direction) {
    local.seconds = 0
  }

  local.props = props

  const current = local
  const isOver = (at: Local) => at.props.direction === 'down' && at.props.ms - at.seconds * 1000 <= 0

  if (current.stop === null && !isOver(current)) {
    current.stop = surface.every(1000, () => {
      const before = clockFace(current.props, current.seconds)

      current.seconds += 1

      const after = clockFace(current.props, current.seconds)

      // A countdown that has run out has nothing more to say.
      if (isOver(current)) {
        current.stop?.()
        current.stop = null
      }

      // Only a face that changed is drawn again: `52m` holds for a minute.
      if (after.text !== before.text || after.color !== before.color) surface.setState(current.seconds)
    })
  }

  const face = clockFace(props, current.seconds)

  return surface.elements.Text({ ...(face.color === undefined ? {} : { color: face.color }), children: face.text })
}

export default Clock
