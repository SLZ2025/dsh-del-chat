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

// Cordis 4 refuses to read a service off the context unless it is declared
// here: `ctx.webServer` throws "cannot get property ... without inject".
export const inject = ['webServer']

logLine('[module] imported ' + String(import.meta.url))

const PREFIX = '/plugin/dsh-del-chat/'
const ROUTES = Object.freeze(['status', 'purge'])
const MAX_REQUEST_BYTES = 8_192
const SESSION_ID = /^session-[0-9a-zA-Z._-]{1,128}$/
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/**
 * Register the confirmation-dialog facts route and the purge route.
 *
 * Plain `exact` routes with a node `handler`, matching the route shape the
 * in-tree optional plugins use: resource routes answer GET/HEAD only, while the
 * purge call has to POST a body.
 * @param ctx - Host context carrying the web server.
 */
export function apply(ctx) {
  logLine(
    '[apply] entered name=' + name
      + ' profileDir=' + String(process.env.DSH_PROFILE_DIR)
      + ' home=' + String(process.env.DSH_HOME),
  )
  try {
    const server = ctx.webServer
    logLine('[apply] webServer=' + typeof server)
    if (!server || typeof server.register !== 'function') {
      logLine('[apply] no webServer on this context')
      return
    }
    for (const action of ROUTES) {
      const path = PREFIX + action
      const dispose = server.register({
        kind: 'exact',
        path,
        handler: (request, response) => {
          void serve(ctx, action, request, response)
        },
      })
      logLine('[apply] route registered ' + path)
      ctx.effect(() => dispose, 'dsh-del-chat: ' + action)
    }
    logLine('[apply] done')
  } catch (error) {
    logLine('[apply] failed: ' + describe(error) + ' | stack: ' + String(error && error.stack))
    throw error
  }
}

/** Bridge one node request/response pair onto the Web handler. */
async function serve(ctx, action, request, response) {
  logLine('[hit] ' + request.method + ' ' + action)
  try {
    const web = await toWebRequest(request, response)
    if (web === null) return
    const result = action === 'purge'
      ? await respondPurge(ctx, web)
      : await respondStatus(ctx, web)
    await writeResponse(response, result)
  } catch (error) {
    logLine('[serve] failed ' + action + ': ' + describe(error))
    try {
      await writeResponse(response, json({ error: 'internal', message: describe(error) }, 500))
    } catch {
      // The socket may already be gone.
    }
  }
}

async function toWebRequest(request, response) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  let body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_REQUEST_BYTES) {
        await writeResponse(response, json({ error: 'payload-too-large' }, 413))
        return null
      }
      chunks.push(buffer)
    }
    if (chunks.length > 0) body = Buffer.concat(chunks)
  }
  const url = new URL(request.url ?? PREFIX, 'http://127.0.0.1')
  return new Request(url, { method: request.method ?? 'GET', headers, body })
}

async function writeResponse(response, result) {
  const headers = {}
  result.headers.forEach((value, key) => {
    headers[key] = value
  })
  response.writeHead(result.status, headers)
  response.end(await result.text())
}

/** Read-only facts the dialog needs before it offers the destructive action. */
async function respondStatus(ctx, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
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
 * @param home - DSH home directory.
 * @param sessionId - session being inspected.
 * @returns the slot directory and projection cache file, or nulls when absent.
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
