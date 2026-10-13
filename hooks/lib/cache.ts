// The main thread's prompt cache. Each request reads the conversation so far
// from the cache and writes what is new; an entry nobody reads for its TTL
// (five minutes, or an hour) is gone, and the next request pays to write the
// whole context again. So the clock that matters runs from the last request.

import type { CacheState } from '../../types'

export const TTL_5M = 5 * 60_000
export const TTL_1H = 60 * 60_000

/** Above this many tokens a cold cache is worth a look: the next message rewrites them all. */
export const COLD_MATTERS_TOKENS = 20_000

export const EMPTY_CACHE: CacheState = {
  lastRequestAt: null,
  ttlMs: TTL_5M,
  isTtlKnown: false,
  hitRatio: null,
  tokens: null,
}

/** How much of a transcript's end is read for the TTL: the last few responses, never the whole file. */
export const TRANSCRIPT_TAIL_BYTES = 262_144

const CREATION = /"cache_creation":\{([^}]*)\}/g

/**
 * The TTL the session's requests write with, from the end of its transcript.
 * The API splits each response's cache writes by TTL
 * (`cache_creation.ephemeral_1h_input_tokens` and `_5m_`); the transcript
 * keeps that split, the usage the engine hands a hook does not. The latest
 * response that wrote anything says. Null when none in `text` did.
 */
export function ttlOfTranscript(text: string): number | null {
  const splits = [...text.matchAll(CREATION)].map(match => match[1] ?? '').reverse()

  for (const split of splits) {
    const hour = Number(/"ephemeral_1h_input_tokens":(\d+)/.exec(split)?.[1] ?? 0)
    const five = Number(/"ephemeral_5m_input_tokens":(\d+)/.exec(split)?.[1] ?? 0)

    if (hour > 0) return TTL_1H
    if (five > 0) return TTL_5M
  }

  return null
}

/**
 * Where the transcript cannot be read: a request sent longer than five
 * minutes after the last one that still read most of its input from the
 * cache proves the entries live an hour.
 */
export function learnTtl(gapMs: number, hitRatio: number): number | null {
  return gapMs > TTL_5M + 30_000 && gapMs < TTL_1H && hitRatio >= 0.5 ? TTL_1H : null
}

/** Share of a request's input the cache served. */
export function hitRatioOf(usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number | null {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

  return total > 0 ? usage.cache_read_input_tokens / total : null
}

/** Time left on the entry the last request refreshed; null before any request. */
export function cacheLeft(cache: CacheState, now: number): number | null {
  if (cache.lastRequestAt === null) return null

  return cache.lastRequestAt + cache.ttlMs - now
}

/** What a stored TTL reads as: one of the two the API has, or nothing. */
export function toTtl(raw: unknown): number | null {
  return raw === TTL_5M || raw === TTL_1H ? raw : null
}
