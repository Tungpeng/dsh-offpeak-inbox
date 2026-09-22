/**
 * Host-side location of the inbox document.
 *
 * The plugin is installed into a profile rather than being part of the harness,
 * so it resolves the DSH home itself: the `DSH_HOME` environment override wins,
 * and the platform home directory is the fallback.
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isAbsolute as posixIsAbsolute, join as posixJoin } from 'node:path/posix'

/** Expand a leading `~` in a path, platform-style. */
export function expandHome(path: string, home: string = homedir()): string {
  const posix = home.startsWith('/')
  const joinPath = posix ? posixJoin : join
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return joinPath(home, path.slice(2))
  return path
}

/**
 * Resolve the DSH home directory.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - platform home directory fallback.
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const posix = home.startsWith('/')
  const joinPath = posix ? posixJoin : join
  const absolute = posix ? posixIsAbsolute : isAbsolute
  const raw = env['DSH_HOME']
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return absolute(expanded) ? expanded : joinPath(process.cwd(), expanded)
  }
  return joinPath(home, '.dsh')
}

/** Resolve the DSH home directory from the live environment. */
export function dshHome(): string {
  return resolveDshHome()
}
