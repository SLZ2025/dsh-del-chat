/**
 * Destructive file work for dsh-del-chat, kept free of cordis so it can be
 * exercised directly by test/purge-core.test.mjs.
 *
 * The Workspace registry never owns a session's log (its README says a
 * registered Workspace does not own the directory and destructive filesystem
 * work must be separately named, explicitly confirmed and checked). These
 * helpers are that separately named step: they validate that the target really
 * is one stored session directory under the persistence root before removing
 * anything.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Normalize a path for containment checks without touching the filesystem. */
function pathKey(value) {
  const normalized = resolve(String(value)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Whether `target` is `parent` itself or lives underneath it.
 * @param parent - absolute directory that must contain the target.
 * @param target - absolute path being checked.
 * @returns whether target is inside parent.
 */
export function isInside(parent, target) {
  const p = pathKey(parent)
  const t = pathKey(target)
  if (t === p) return true
  return t.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * Refuse any directory that is not exactly one stored session slot under the
 * persistence root. The session id is the slot name, so a mismatch means the
 * caller aimed at something else.
 * @param sessionsRoot - the JSONL persistence root.
 * @param sessionDir - the candidate directory.
 * @param sessionId - the session id that must name the slot.
 */
export function assertSessionDir(sessionsRoot, sessionDir, sessionId) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) {
    throw new Error('session directory unknown')
  }
  if (basename(pathKey(sessionDir)) !== String(sessionId).toLowerCase()) {
    throw new Error('session directory does not match the session id')
  }
  if (!isInside(sessionsRoot, sessionDir)) {
    throw new Error('session directory outside the persistence root')
  }
}

/**
 * Total bytes of a directory tree; zero for a missing directory.
 * @param directory - directory to measure.
 * @returns byte total.
 */
export function measureDirectory(directory) {
  let total = 0
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(directory, entry.name)
    try {
      if (entry.isDirectory()) total += measureDirectory(child)
      else if (entry.isFile()) total += statSync(child).size
    } catch {
      // A file that vanished between listing and stat contributes nothing.
    }
  }
  return total
}

/**
 * Remove one archived session's stored artifacts.
 *
 * Order matters: nothing is deleted until every check passed, so a refusal
 * leaves the install untouched. Only the session directory and its projection
 * cache slot are touched; attachments are content addressed and shared between
 * sessions, so they are never removed here.
 * @param options - root, slot directory and cache file to remove.
 * @returns what was removed and how many bytes went with the log.
 */
export function removeSessionArtifacts(options) {
  const { sessionsRoot, sessionDir, projCacheRoot, projCacheFile } = options
  assertSessionDir(sessionsRoot, sessionDir, options.sessionId)
  const bytes = measureDirectory(sessionDir)
  const removed = []
  const skipped = []

  rmSync(sessionDir, { recursive: true, force: true })
  removed.push('session-log')

  if (typeof projCacheFile === 'string' && projCacheFile.length > 0) {
    if (!isInside(projCacheRoot, projCacheFile)) {
      skipped.push('projection-cache-outside-root')
    } else if (existsSync(projCacheFile)) {
      rmSync(projCacheFile, { force: true })
      removed.push('projection-cache')
    }
  }

  return { bytes, removed, skipped }
}

/**
 * The projection cache slot the projection-cache plugin keeps for one session.
 * @param home - DSH home directory.
 * @param sessionId - session whose slot is wanted.
 * @returns absolute cache file path.
 */
export function projCachePath(home, sessionId) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * Parent directory of a stored log file, which is the session slot.
 * @param logPath - the backend-reported log path.
 * @returns the session directory, or null when no path was reported.
 */
export function sessionDirOf(logPath) {
  if (typeof logPath !== 'string' || logPath.length === 0) return null
  return dirname(logPath)
}
