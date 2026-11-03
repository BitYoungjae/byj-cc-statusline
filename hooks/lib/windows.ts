// The life of a rate-limit window: what the engine reports on a response, what
// an earlier session remembered, and when a remembered one stops being worth
// showing. Pure data, like everything in `lib/` — no `$` anywhere.

import type { Usage, WindowReading } from '../../types'

/** How long each window runs. A remembered reading older than this past its
 * reset cannot be the current window waiting for its next report. */
export const WINDOW_SPAN_MS = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}

/** A reading as the engine reports it on a response. Whatever it says is live:
 * Claude Code drops a window the moment it resets, so a missing one means
 * "reset just now, next report pending" — or, since the 2026-10-30 plan
 * update, that the plan no longer has the window at all. */
export type LiveReading = { kind: string; percentUsed: number; resetsAt?: string | null }

/** What `$.store` kept from an earlier session, or nothing when it is not the shape written. */
export function toWindows(raw: unknown): Usage['windows'] {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  return { five_hour: toReading(stored.five_hour), seven_day: toReading(stored.seven_day) }
}

/**
 * Merges the live readings into the remembered windows. Live always wins; a
 * remembered window survives only as a bridge — the band keeps showing it,
 * dimmed, while it could still be the current window waiting for its next
 * report. One reset by more than the window is long has rolled over (or never
 * existed: a verified Ultra account has had no 5h session window since the
 * 2026-10-30 plan update), and a bridge that never ends is litter. A reading
 * without a date cannot be told apart from those, so it goes the same way.
 */
export function mergeWindows(remembered: Usage['windows'], live: readonly LiveReading[], now: number): Usage['windows'] {
  const next: Usage['windows'] = { five_hour: null, seven_day: null }

  for (const one of live) {
    if (one.kind === 'five_hour' || one.kind === 'seven_day') {
      next[one.kind] = { percentUsed: one.percentUsed, resetsAt: one.resetsAt ?? null }
    }
  }

  for (const kind of ['five_hour', 'seven_day'] as const) {
    const was = remembered[kind]

    if (next[kind] !== null || was === null) continue

    const resetsAt = was.resetsAt === null ? NaN : Date.parse(was.resetsAt)

    if (Number.isFinite(resetsAt) && resetsAt + WINDOW_SPAN_MS[kind] > now) next[kind] = was
  }

  return next
}

function toReading(raw: unknown): WindowReading | null {
  if (typeof raw !== 'object' || raw === null) return null

  const { percentUsed, resetsAt } = raw as Record<string, unknown>

  if (typeof percentUsed !== 'number') return null

  return {
    percentUsed,
    resetsAt: typeof resetsAt === 'string' ? resetsAt : null,
  }
}
