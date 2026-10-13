import { describe, expect, test } from 'claude-code/testing'

import { cacheLeft, EMPTY_CACHE, hitRatioOf, learnTtl, toTtl, TTL_1H, TTL_5M, ttlOfTranscript } from '../hooks/lib/cache'

const line = (hour: number, five: number) =>
  JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_creation: { ephemeral_1h_input_tokens: hour, ephemeral_5m_input_tokens: five } } },
  })

describe('the TTL, from the transcript', () => {
  test('the latest response that wrote anything says', () => {
    expect(ttlOfTranscript([line(0, 900), line(1945, 0)].join('\n'))).toBe(TTL_1H)
    expect(ttlOfTranscript([line(1945, 0), line(0, 900)].join('\n'))).toBe(TTL_5M)
  })

  test('a response that wrote nothing is passed over', () => {
    expect(ttlOfTranscript([line(500, 0), line(0, 0)].join('\n'))).toBe(TTL_1H)
  })

  test('the keys come in either order', () => {
    expect(ttlOfTranscript('"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":12}')).toBe(TTL_1H)
  })

  test('a transcript with no writes, or cut off, says nothing', () => {
    expect(ttlOfTranscript('')).toBeNull()
    expect(ttlOfTranscript('{"type":"user"}\n"cache_creation":{"ephem')).toBeNull()
  })
})

describe('the TTL, learnt', () => {
  test('a read after a gap past five minutes proves an hour', () => {
    expect(learnTtl(7 * 60_000, 0.9)).toBe(TTL_1H)
  })

  test('a short gap, or a miss, proves nothing', () => {
    expect(learnTtl(2 * 60_000, 0.9)).toBeNull()
    expect(learnTtl(7 * 60_000, 0.1)).toBeNull()
    expect(learnTtl(2 * TTL_1H, 0.9)).toBeNull()
  })

  test('a stored TTL is one of the two, or none', () => {
    expect(toTtl(TTL_1H)).toBe(TTL_1H)
    expect(toTtl(42)).toBeNull()
    expect(toTtl('1h')).toBeNull()
  })
})

describe('the entry', () => {
  test('the hit ratio is the cache`s share of the input', () => {
    expect(hitRatioOf({ input_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 8 })).toBe(0.9)
    expect(hitRatioOf({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeNull()
  })

  test('time left runs from the last request', () => {
    const cache = { ...EMPTY_CACHE, lastRequestAt: 1_000_000, ttlMs: TTL_5M }

    expect(cacheLeft(cache, 1_000_000 + 60_000)).toBe(4 * 60_000)
    expect(cacheLeft(cache, 1_000_000 + TTL_5M + 1)).toBe(-1)
    expect(cacheLeft(EMPTY_CACHE, 5)).toBeNull()
  })
})
