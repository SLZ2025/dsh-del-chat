/**
 * Host half of dsh-del-chat.
 *
 * DSH can hide a Session (archive) but nothing deletes one: the JSONL seam says
 * "Nothing deletes session files ... the seam has no deletion API", and the
 * Workspace registry only drops a session from its account. This plugin adds the
 * separately named, explicitly confirmed destructive step as two exact routes on
 * the *authenticated* API channel:
 *
 *   GET|HEAD /api/dsh-del-chat/status?sessionId=…  read-only facts for the
 *                                                  confirmation dialog
 *   POST     /api/dsh-del-chat/purge {sessionId}   delete one *archived* slot
 *
 * Both routes go through `connection.fetch`, the seam the in-tree plugins use:
 * Connection applies its Host/Origin trust checks and browser authentication
 * before the handler runs, and only an owner Peer reaches an exact route. A
 * plain `webServer` route would be anonymous, which is why this plugin must not
 * use one.
 *
 * The registry is never bypassed: the session is detached from its Workspace
 * account through the entity API and unarchived through the registry API, so
 * the durable `workspace` domain is written on its own write chain. Only the
 * stored log slot and the projection-cache slot are deleted; attachments are
 * content addressed and shared between sessions and are therefore never
 * touched.
 */
import { appendFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  measureDirectory,
  projCachePath,
  removeSessionArtifacts,
  sessionDirOf,
} from './purge-core.js'

const LOG_CANDIDATES = [
  process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'dsh-del-chat.log'),
  process.env.DSH_HOME && join(process.env.DSH_HOME, 'dsh-del-chat.log'),
  join(tmpdir(), 'dsh-del-chat.log'),
].filter(Boolean)

function logLine(line) {
  const text = new Date().toISOString() + ' ' + line + '\n'
  for (const target of LOG_CANDIDATES) {
    try {
      appendFileSync(target, text)
      return
    } catch {
      // Try the next candidate: logging must never break the plugin.
    }
  }
}

export const name = 'dsh-del-chat'

// Cordis 4 refuses to read a service off the context unless it is declared here:
// `ctx.connection` throws "cannot get property ... without inject".
export const inject = ['connection']

logLine('[module] imported ' + String(import.meta.url))

const STATUS_PATH = '/api/dsh-del-chat/status'
const PURGE_PATH = '/api/dsh-del-chat/purge'
const MAX_REQUEST_BYTES = 8_192
const SESSION_ID = /^session-[0-9a-zA-Z._-]{1,128}$/
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/**
 * Register the confirmation-dialog facts route and the purge route on the
 * authenticated shared API channel.
 *
 * The handlers receive an already admitted `Request` and return a `Response`:
 * Connection has applied its trust and authentication policy before dispatch,
 * so there is no anonymous surface left for a browser page to call.
 * @param ctx - Host context carrying the Connection service.
 */
export function apply(ctx) {
  logLine(
    '[apply] entered name=' + name
      + ' profileDir=' + String(process.env.DSH_PROFILE_DIR)
      + ' home=' + String(process.env.DSH_HOME),
  )
  try {
    const connection = ctx.connection
    logLine('[apply] connection=' + typeof connection)
    if (!connection || typeof connection.fetch?.register !== 'function') {
      logLine('[apply] no connection.fetch on this context')
      return
    }
    // Registration returns an async disposer; tie it to this fiber so a plugin
    // reload (disable → enable) re-registers cleanly instead of colliding with the
    // previous registration.
    const disposers = []
    try {
      disposers.push(connection.fetch.register({
        path: STATUS_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async (request) => headless(request, await statusResponse(ctx, request)),
      }))
      logLine('[apply] route registered ' + STATUS_PATH)
      disposers.push(connection.fetch.register({
        path: PURGE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => purgeResponse(ctx, request),
      }))
      logLine('[apply] route registered ' + PURGE_PATH)
    } finally {
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          Promise.resolve()
            .then(() => dispose())
            .catch((error) => logLine('[apply] route dispose failed: ' + describe(error)))
        }
      }, 'dsh-del-chat: routes')
    }
    ctx.effect(() => ctx.on('session/disposed', (session) => {
      const disposed = String(session?.id ?? '')
      if (disposed === '') return
      void reconcileArchived(ctx, disposed).catch((error) => {
        logLine('[reconcile] disposed ' + disposed + ' failed: ' + describe(error))
      })
    }), 'dsh-del-chat: settle when the host releases a session')
    void reconcileAll(ctx).catch((error) => logLine('[reconcile] sweep failed: ' + describe(error)))
    logLine('[apply] done')
  } catch (error) {
    logLine('[apply] failed: ' + describe(error) + ' | stack: ' + String(error && error.stack))
    throw error
  }
}

/**
 * Answer a HEAD probe without a body, so the dialog can ask for facts cheaply.
 * @param request - the admitted request.
 * @param response - the response built for GET.
 */
async function headless(request, response) {
  if (request.method !== 'HEAD') return response
  await response.body?.cancel()
  return new Response(null, { status: response.status, headers: response.headers })
}

/** Read-only facts the dialog needs before it offers the destructive action. */
async function statusResponse(ctx, request) {
  logLine('[hit] ' + request.method + ' status')
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
    if (!SESSION_ID.test(sessionId)) return json({ error: 'invalid-session-id' }, 400)
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return json({ error: 'workspace-registry-unavailable' }, 503)

    const archived = registry.archivedSessionIds.includes(sessionId)
    const facts = await storedFacts(ctx, sessionId)
    return json({
      sessionId,
      archived,
      exists: facts.sessionDir !== null,
      bytes: facts.sessionDir === null ? 0 : measureDirectory(facts.sessionDir),
      projCache: facts.projCacheFile !== null,
      ...await diagnostics(ctx, sessionId),
    })
  } catch (error) {
    logLine('[status] failed: ' + describe(error))
    return json({ error: 'internal', message: describe(error) }, 500)
  }
}

/**
 * Report whether the Host still holds this Session in memory or still lists it in
 * its catalog. Both are true for a Session whose log was deleted while it stayed
 * resident: the catalog is the reason a sidebar row can outlive the bytes.
 * @param ctx - plugin context used to reach the Session store and the query service.
 * @param sessionId - Session to inspect.
 * @returns `resident` and `listed` flags; `undefined` when a service is unavailable.
 */
async function diagnostics(ctx, sessionId) {
  const result = {}
  try {
    const sessions = ctx.get('sessions')
    result.resident = typeof sessions?.get === 'function' ? sessions.get(sessionId) !== undefined : undefined
  } catch (error) {
    result.resident = undefined
    logLine('[status] resident probe failed: ' + describe(error))
  }
  try {
    const query = ctx.get('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const records = await query.listSessions()
      const ids = records.map((record) => String(record?.header?.id ?? ''))
      result.listed = ids.includes(sessionId)
      result.catalogSize = ids.length
    } else {
      result.listed = undefined
    }
  } catch (error) {
    result.listed = undefined
    logLine('[status] listed probe failed: ' + describe(error))
  }
  return result
}

/** Delete one archived session after every safety check passed. */
async function purgeResponse(ctx, request) {
  logLine('[hit] POST purge')
  try {
    const body = await readJson(request)
    if (body === null || !SESSION_ID.test(String(body.sessionId ?? ''))) {
      return json({ error: 'invalid-session-id' }, 400)
    }
    const sessionId = String(body.sessionId)
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return json({ error: 'workspace-registry-unavailable' }, 503)

    // Archival is the admission rule: only a session the user already archived can
    // lose its log, matching the "separately named, explicitly confirmed" rule of
    // the Workspace package.
    if (!registry.archivedSessionIds.includes(sessionId)) {
      return json({ error: 'not-archived' }, 409)
    }

    logLine('[purge] start ' + sessionId)
    const facts = await storedFacts(ctx, sessionId)
    if (facts.home === null) {
      logLine('[purge] no dsh home for ' + sessionId)
      return json({ error: 'dsh-home-unknown' }, 500)
    }
    if (facts.sessionDir === null) {
      // The log is already gone: finish the registry bookkeeping so the archived id
      // does not linger forever, and drop any stale row a Client still holds.
      const held = isResident(ctx, sessionId)
      if (!held) await settleRegistry(registry, sessionId)
      broadcastRemoved(ctx, sessionId)
      return json({ ok: true, bytes: 0, removed: ['registry-only'], settled: !held })
    }

    // Delete first, then settle the registry. A failed unlink must leave the Session
    // exactly as the user found it — still archived, still in its workspace group —
    // so the menu item is still there to retry. Settling first would move the row to
    // Ungrouped and clear the archive mark, and the row would no longer offer a retry.
    let result
    try {
      result = removeSessionArtifacts({
        sessionId,
        sessionsRoot: join(facts.home, 'sessions'),
        sessionDir: facts.sessionDir,
        projCacheRoot: join(facts.home, 'storages', 'session_projcache', 'sessions'),
        projCacheFile: facts.projCacheFile,
      })
    } catch (error) {
      const message = describe(error)
      logLine('[purge] failed ' + sessionId + ': ' + message)
      if (/EBUSY|EPERM|ENOTEMPTY/i.test(message)) {
        return json({ error: 'log-locked', message }, 423)
      }
      return json({ error: 'delete-failed', message }, 500)
    }
    logLine('[purge] done ' + sessionId + ' bytes=' + String(result.bytes) + ' removed=' + result.removed.join(',') + ' skipped=' + result.skipped.join(','))
    // The bytes are already gone; a registry failure here must not turn a successful
    // delete into an error the user would retry against missing files.
    const held = isResident(ctx, sessionId)
    if (held) {
      // The Host still holds this Session in memory, so its cataloged row survives the
      // delete. Settling now would detach it and clear the archive mark, and the Client
      // would render the ghost as an Ungrouped row on its next list read. Keep both
      // marks until `session/disposed` reports the Host actually let go, then settle.
      logLine('[purge] still resident, registry settles when the host releases it')
    } else {
      try {
        await settleRegistry(registry, sessionId)
      } catch (error) {
        logLine('[purge] registry settle failed ' + sessionId + ': ' + describe(error))
      }
    }
    broadcastRemoved(ctx, sessionId)
    return json({
      ok: true,
      bytes: result.bytes,
      removed: result.removed,
      skipped: result.skipped,
      settled: !held,
    })
  } catch (error) {
    logLine('[purge] threw: ' + describe(error) + ' | stack: ' + String(error && error.stack))
    return json({ error: 'internal', message: describe(error) }, 500)
  }
}

/**
 * Tell every connected Client that this Session is gone. `api-session/removed` is
 * the Host event the sidebar's Session catalog already listens for: `dsh-api-remotes`
 * forwards it to Clients and `dsh-api-session-controller` turns it into a list
 * removal, so the row leaves the sidebar without a page reload or a GUI restart.
 * @param ctx - plugin context used to emit the Host event.
 * @param sessionId - Session whose row must leave every Client list.
 */
function broadcastRemoved(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
    logLine('[purge] broadcast api-session/removed ' + sessionId)
  } catch (error) {
    logLine('[purge] broadcast failed ' + sessionId + ': ' + describe(error))
  }
}

/**
 * Whether the Host still holds this Session in memory. A resident Session stays in
 * the Host catalog even after its log is deleted, so its row can outlive the bytes;
 * that is the one case this plugin cannot settle on the spot.
 * @param ctx - Host context carrying the Session store.
 * @param sessionId - Session to test.
 * @returns true when the Session store still returns it.
 */
function isResident(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    return typeof sessions?.get === 'function' ? sessions.get(sessionId) !== undefined : false
  } catch {
    return false
  }
}

/**
 * Finish a delete whose Session the Host has since released: detach it from its
 * workspace, drop the archived mark, and tell Clients to drop the row.
 * @param ctx - Host context.
 * @param sessionId - Session the Host just disposed.
 * @returns true when this call settled the session.
 */
async function reconcileArchived(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return false
  if (!registry.archivedSessionIds.includes(sessionId)) return false
  if (isResident(ctx, sessionId)) return false
  const facts = await storedFacts(ctx, sessionId)
  if (facts.home === null || facts.sessionDir !== null) return false
  await settleRegistry(registry, sessionId)
  broadcastRemoved(ctx, sessionId)
  logLine('[reconcile] settled released session ' + sessionId)
  return true
}

/**
 * Sweep archived ids at start so a Session deleted under an older version, or while
 * it was resident, does not keep a durable archive mark forever.
 * @param ctx - Host context.
 */
async function reconcileAll(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return
  const ids = [...registry.archivedSessionIds]
  if (ids.length === 0) return
  let settled = 0
  for (const id of ids) {
    try {
      if (await reconcileArchived(ctx, id)) settled += 1
    } catch (error) {
      logLine('[reconcile] ' + id + ' failed: ' + describe(error))
    }
  }
  logLine('[reconcile] archived ids checked=' + String(ids.length) + ' settled=' + String(settled))
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
  // Detach from every workspace, not just the one whose filtered view still shows
  // the id: the visible `sessionIds` getter hides ids whose log is already gone,
  // so asking it would leave the stale id in the durable record and the Session
  // would keep showing up in the sidebar until the next restart.
  for (const entity of entities) {
    try {
      const before = entity.sessionIds.length
      const view = await entity.detachSession(sessionId)
      const after = Array.isArray(view?.sessionIds) ? view.sessionIds.length : before
      if (after !== before) logLine('[settle] detached from workspace ' + String(entity.id ?? '?') + ' (' + before + ' -> ' + after + ')')
    } catch (error) {
      logLine('[settle] detach failed: ' + describe(error))
    }
  }
  try {
    await registry.unarchiveSession(sessionId)
    logLine('[settle] archive mark cleared')
  } catch (error) {
    // The archive mark may already be gone; the delete must still proceed.
    logLine('[settle] unarchive failed: ' + describe(error) + ' | stack: ' + String(error && error.stack))
  }
}

/**
 * Where the stored artifacts of one session live, according to the persistence
 * backend rather than a guessed path layout.
 * @param ctx - Host context.
 * @param sessionId - session being inspected.
 * @returns the slot directory, projection cache file and DSH home, or nulls.
 */
async function storedFacts(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  let logPath = null
  if (persistence && typeof persistence.stat === 'function') {
    try {
      const snapshot = await persistence.stat(sessionId)
      logPath = snapshot?.location?.path ?? null
    } catch {
      logPath = null
    }
  }
  const sessionDir = sessionDirOf(logPath)
  const home = homeOf(logPath)
  let projCacheFile = home === null ? null : projCachePath(home, sessionId)
  if (projCacheFile !== null && !existsSync(projCacheFile)) projCacheFile = null
  return { sessionDir, projCacheFile, home }
}

/**
 * DSH home. The desktop Host runs without `DSH_HOME`/`DSH_PROFILE_DIR`, so the
 * stored log path is the primary source: `<home>/sessions/<key>/session-<id>/`.
 * @param logPath - stored log path of any session, when known.
 */
function homeOf(logPath) {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) return dirname(dirname(profileDir))
  if (typeof logPath === 'string' && logPath.length > 0) {
    const candidate = dirname(dirname(dirname(dirname(logPath))))
    if (existsSync(join(candidate, 'storages'))) return candidate
  }
  const fallback = join(homedir(), '.dsh')
  if (existsSync(join(fallback, 'storages'))) return fallback
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

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  })
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
