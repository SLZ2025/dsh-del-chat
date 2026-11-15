/**
 * Host half of dsh-del-chat.
 *
 * DSH can hide a Session (archive) but nothing deletes one: the JSONL seam says
 * "Nothing deletes session files ... the seam has no deletion API", and the
 * Workspace registry only drops a session from its account. This plugin adds the
 * separately named, explicitly confirmed destructive step as two same-origin
 * routes:
 *
 *   GET  /plugin/dsh-del-chat/status?sessionId=…  read-only facts for the
 *                                                 confirmation dialog
 *   POST /plugin/dsh-del-chat/purge {sessionId}   delete one *archived* slot
 *
 * The registry is never bypassed: the session is detached from its Workspace
 * account through the entity API and unarchived through the registry API, so
 * the durable `workspace` domain is written on its own write chain. Only the
 * stored log slot and the projection-cache slot are deleted; attachments are
 * content addressed and shared between sessions and are therefore never
 * touched.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  measureDirectory,
  projCachePath,
  removeSessionArtifacts,
  sessionDirOf,
} from './purge-core.js'

export const name = 'dsh-del-chat'
export const inject = ['webServer']

const PREFIX = '/plugin/dsh-del-chat/'
const MAX_REQUEST_BYTES = 8_192
const SESSION_ID = /^session-[0-9a-zA-Z._-]{1,128}$/
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/**
 * Register the confirmation-dialog facts route and the purge route.
 * @param ctx - Host context carrying the web server.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    resource: request => handle(ctx, request),
  }), 'dsh-del-chat: routes')
}

async function handle(ctx, request) {
  const action = new URL(request.url).pathname.slice(PREFIX.length)
  try {
    if (action === 'status') return await respondStatus(ctx, request)
    if (action === 'purge') return await respondPurge(ctx, request)
  } catch (error) {
    return json({ error: 'internal', message: describe(error) }, 500)
  }
  return json({ error: 'not-found' }, 404)
}

/** Read-only facts the dialog needs before it offers the destructive action. */
async function respondStatus(ctx, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
  if (!SESSION_ID.test(sessionId)) return json({ error: 'invalid-session-id' }, 400)
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return json({ error: 'workspace-registry-unavailable' }, 503)
  const home = homeOf()
  if (home === null) return json({ error: 'dsh-home-unknown' }, 500)

  const archived = registry.archivedSessionIds.includes(sessionId)
  const facts = await storedFacts(ctx, home, sessionId)
  return json({
    sessionId,
    archived,
    exists: facts.sessionDir !== null,
    bytes: facts.sessionDir === null ? 0 : measureDirectory(facts.sessionDir),
    projCache: facts.projCacheFile !== null,
  })
}

/** Delete one archived session after every safety check passed. */
async function respondPurge(ctx, request) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const body = await readJson(request)
  if (body === null || !SESSION_ID.test(String(body.sessionId ?? ''))) {
    return json({ error: 'invalid-session-id' }, 400)
  }
  const sessionId = String(body.sessionId)
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return json({ error: 'workspace-registry-unavailable' }, 503)
  const home = homeOf()
  if (home === null) return json({ error: 'dsh-home-unknown' }, 500)

  // Archival is the admission rule: only a session the user already archived can
  // lose its log, matching the "separately named, explicitly confirmed" rule of
  // the Workspace package.
  if (!registry.archivedSessionIds.includes(sessionId)) {
    return json({ error: 'not-archived' }, 409)
  }

  const facts = await storedFacts(ctx, home, sessionId)
  if (facts.sessionDir === null) {
    // The log is already gone: finish the registry bookkeeping so the archived id
    // does not linger forever.
    await settleRegistry(registry, sessionId)
    return json({ ok: true, bytes: 0, removed: ['registry-only'] })
  }

  // Unarchive before deleting: the registry refuses to archive an active session,
  // so an archived one has no live writer, but its id must still leave the
  // archive set through the domain write chain rather than by editing JSON.
  await settleRegistry(registry, sessionId)

  let result
  try {
    result = removeSessionArtifacts({
      sessionId,
      sessionsRoot: join(home, 'sessions'),
      sessionDir: facts.sessionDir,
      projCacheRoot: join(home, 'storages', 'session_projcache', 'sessions'),
      projCacheFile: facts.projCacheFile,
    })
  } catch (error) {
    const message = describe(error)
    if (/EBUSY|EPERM|ENOTEMPTY/i.test(message)) {
      return json({ error: 'log-locked', message }, 423)
    }
    return json({ error: 'delete-failed', message }, 500)
  }
  return json({ ok: true, bytes: result.bytes, removed: result.removed, skipped: result.skipped })
}

/**
 * Detach the session from whichever Workspace accounts for it, then drop the
 * archived mark. Both go through the registry so durability and the follow feed
 * stay authoritative.
 * @param registry - the Workspace registry service.
 * @param sessionId - the session being deleted.
 */
async function settleRegistry(registry, sessionId) {
  let entities = []
  try {
    entities = registry.list()
  } catch {
    entities = []
  }
  for (const entity of entities) {
    const owned = typeof entity.sessionIds === 'object' && entity.sessionIds !== null
    if (!owned) continue
    if (!Array.from(entity.sessionIds).includes(sessionId)) continue
    await entity.detachSession(sessionId)
    break
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch {
    // The archive mark may already be gone; the delete must still proceed.
  }
}

/**
 * Where the stored artifacts of one session live, according to the persistence
 * backend rather than a guessed path layout.
 * @param ctx - Host context.
 * @param home - DSH home directory.
 * @param sessionId - session being inspected.
 * @returns the slot directory and projection cache file, or nulls when absent.
 */
async function storedFacts(ctx, home, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  let sessionDir = null
  if (persistence && typeof persistence.stat === 'function') {
    try {
      const snapshot = await persistence.stat(sessionId)
      sessionDir = sessionDirOf(snapshot?.location?.path)
    } catch {
      sessionDir = null
    }
  }
  let projCacheFile = projCachePath(home, sessionId)
  if (!existsSync(projCacheFile)) projCacheFile = null
  return { sessionDir, projCacheFile }
}

/** DSH home from the environment, with the profile directory as a fallback. */
function homeOf() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) return dirname(dirname(profileDir))
  return null
}

async function readJson(request) {
  try {
    const text = await request.text()
    if (text.length > MAX_REQUEST_BYTES) return null
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function methodNotAllowed(allow) {
  return json({ error: 'method-not-allowed' }, 405, { allow })
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  })
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
