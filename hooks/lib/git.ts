import type { GitInfo } from '../../types'

/**
 * The argv for one status read. `--no-optional-locks` keeps a status bar from
 * taking the index lock a person's own `git add` may be waiting on, and
 * `gc.autodetach=false` keeps git from forking a background gc under it.
 */
export const GIT_STATUS_ARGV = [
  'git',
  '-c',
  'gc.autodetach=false',
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '--branch',
] as const

/**
 * Reads `git status --porcelain=v2 --branch`.
 *
 * Counts files, not letters: a file changed in both the index and the working
 * tree counts once under each, as the original's two dots did.
 */
export function parseGitStatus(output: string): GitInfo | null {
  let head = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let staged = 0
  let modified = 0
  let untracked = 0
  let conflicted = 0

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(counts?.[1] ?? 0)
      behind = Number(counts?.[2] ?? 0)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // `1 XY ...` and `2 XY ...`: X is the index, Y the working tree.
      if (line.charAt(2) !== '.') staged += 1
      if (line.charAt(3) !== '.') modified += 1
    } else if (line.startsWith('u ')) {
      conflicted += 1
    } else if (line.startsWith('? ')) {
      untracked += 1
    }
  }

  if (head === '') return null

  const isDetached = head === '(detached)'

  return {
    branch: isDetached ? oid.slice(0, 7) : head,
    isDetached,
    staged,
    modified,
    untracked,
    conflicted,
    ahead,
    behind,
  }
}

export function isClean(git: GitInfo): boolean {
  return (
    git.staged + git.modified + git.untracked + git.conflicted === 0
  )
}
