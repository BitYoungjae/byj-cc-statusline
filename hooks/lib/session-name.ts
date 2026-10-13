// Claude Code lets sessions message each other by name, and that name is not
// the conversation title on stdin: it lives in the session registry, one JSON
// file per live session named by pid (`~/.claude/sessions/<pid>.json`), keyed
// inside by `sessionId`. A derived name is `<dir>-XX`.

export type RegistryEntry = {
  sessionId: string
  name: string
  updatedAt: number
}

/** The registry files worth reading, newest first: `<pid>.json`, never the `.key` files beside them. */
export function registryFiles(
  entries: readonly { name: string; mtimeMs: number }[],
  limit = 40,
): string[] {
  return entries
    .filter(entry => /^\d+\.json$/.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(entry => entry.name)
}

/**
 * One file's entry, or null when it is not one: a file a session was killed
 * in the middle of writing is cut off, and costs only itself.
 */
export function parseEntry(text: string): RegistryEntry | null {
  try {
    const raw: unknown = JSON.parse(text)

    if (typeof raw !== 'object' || raw === null) return null

    const { sessionId, name, updatedAt } = raw as Record<string, unknown>

    if (typeof sessionId !== 'string' || typeof name !== 'string') return null
    if (name === '') return null

    return {
      sessionId,
      name,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    }
  } catch {
    return null
  }
}

/** A resumed session can leave its previous pid's file behind: the latest update wins. */
export function pickName(
  entries: readonly (RegistryEntry | null)[],
  sessionId: string,
): string | null {
  let best: RegistryEntry | null = null

  for (const entry of entries) {
    if (entry === null || entry.sessionId !== sessionId) continue
    if (best === null || entry.updatedAt >= best.updatedAt) best = entry
  }

  return best?.name ?? null
}

/**
 * What goes beside the directory. A derived name is `<dir>-XX`, so showing it
 * next to the directory would say the same thing twice: it takes the
 * directory's place. A name that has become something else (after /rename)
 * gets a tag of its own and the directory stays.
 */
export function placeName(
  dir: string,
  sessionName: string | null,
): { place: string; tag: string | null } {
  if (sessionName === null) return { place: dir, tag: null }

  const covers = sessionName === dir || sessionName.startsWith(`${dir}-`)

  return covers
    ? { place: sessionName, tag: null }
    : { place: dir, tag: sessionName }
}
