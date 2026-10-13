// One cell that turns while the main loop works: a quarter block walking
// round the cell, eight steps, all of them block elements every coding font
// has. It runs on the surface's frame clock; the band never redraws for it.

import type { ClientModule } from 'claude-code'

export type SpinnerProps = { color: string }

const FRAMES = ['▘', '▀', '▝', '▐', '▗', '▄', '▖', '▌']
const STEP_MS = 120

// The instances already turning: a call before the first tick must not start a second clock.
const turning = new WeakSet<object>()

const Spinner: ClientModule<SpinnerProps, number> = (props, surface) => {
  if (!turning.has(surface)) {
    turning.add(surface)
    surface.every(STEP_MS, () => surface.setState(((surface.state ?? 0) + 1) % FRAMES.length))
  }

  return surface.elements.Text({ color: props.color, children: FRAMES[surface.state ?? 0] ?? FRAMES[0] })
}

export default Spinner
