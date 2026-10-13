// What the person's settings say about effort. Current builds keep it per
// model (`modelSettings["claude-opus-5-5"].effortLevel`); older ones kept a
// single `effortLevel` at the top, which still counts when there is no entry
// for the model.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** The effort level the settings hold for `model`, or null when they hold none. */
export function effortSetting(settings: unknown, model: string): string | null {
  const all = record(settings)

  if (all === null) return null

  const perModel = record(all.modelSettings)
  // A model id can carry a context suffix (`claude-opus-5-5[1m]`) its settings key lacks.
  const entry = record(perModel?.[model]) ?? record(perModel?.[model.replace(/\[[^\]]*\]$/, '')])
  const level = entry?.effortLevel ?? all.effortLevel

  return typeof level === 'string' && level !== '' ? level : null
}
