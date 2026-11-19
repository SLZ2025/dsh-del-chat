import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const SESSION_ID = 'session-aaaa'
const STATUS_PATH = '/api/dsh-del-chat/status'
const PURGE_PATH = '/api/dsh-del-chat/purge'
const ORIGIN = 'http://127.0.0.1:3080'

/** A Host context stub with just the seam this plugin touches. */
function harness({ archived = [SESSION_ID], dir = true, env = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-del-chat-host-'))
  const project = join(home, 'sessions', '--D-workspace--')
  const sessionDir = join(project, SESSION_ID)
  const projCacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(projCacheRoot, { recursive: true })
  if (dir) {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 1))
    writeFileSync(join(projCacheRoot, `${SESSION_ID}.json`), '{}')
  }

  const archivedIds = new Set(archived)
  const calls = { detach: [], unarchive: [], routes: [], events: [], listeners: [], resident: new Set() }
  const entity = {
    id: 'ws-1',
    path: 'D:\\workspace',
    title: 'workspace',
    get sessionIds() {
      return calls.detach.length === 0 ? [SESSION_ID] : []
    },
    async detachSession(id) {
      calls.detach.push(id)
    },
  }
  const registry = {
    get archivedSessionIds() {
      return [...archivedIds]
    },
    list: () => [entity],
    async unarchiveSession(id) {
      calls.unarchive.push(id)
      archivedIds.delete(id)
    },
  }
  const persistence = {
    async stat(id) {
      const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
      if (!dir || id !== SESSION_ID || !existsSync(logPath)) return undefined
      return { location: { path: logPath } }
    },
  }
  const ctx = {
    effect: (fn) => {
      fn()
    },
    on(event, listener) {
      calls.listeners.push([event, listener])
      return () => {}
    },
    emit(event, sessionId) {
      calls.events.push([event, sessionId])
    },
    // The authenticated seam: Connection admits the request before dispatch, so the
    // plugin only ever sees admitted Requests and returns Responses.
    connection: {
      fetch: {
        register(spec) {
          calls.routes.push(spec)
          return async () => {}
        },
      },
    },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') {
        return {
          get: (id) => (calls.resident.has(id) ? { id } : undefined),
        }
      }
      return undefined
    },
  }

  const previous = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  if (env) {
    process.env.DSH_HOME = home
  } else {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE_DIR
  }
  apply(ctx)
  return {
    home,
    sessionDir,
    archive: (id) => archivedIds.add(id),
    projCacheFile: join(projCacheRoot, `${SESSION_ID}.json`),
    calls,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
      else process.env.DSH_PROFILE_DIR = previousProfile
    },
  }
}

/** Drive one registered Fetch route the way Connection does after admission. */
function call(h, path, { method = 'GET', body, search = '' } = {}) {
  const spec = h.calls.routes.find((route) => route.path === path)
  assert.ok(spec, `no route registered for ${path}`)
  assert.ok(spec.methods.includes(method), `${path} does not own ${method}`)
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return spec.fetch(new Request(ORIGIN + path + search, init))
}

const bodyOf = (response) => response.json()

test('registers both routes on the authenticated API channel', () => {
  const h = harness()
  try {
    assert.deepEqual(
      h.calls.routes.map((route) => [route.path, route.methods.join(','), route.requestBody, typeof route.fetch]),
      [
        [STATUS_PATH, 'GET,HEAD', 'buffered', 'function'],
        [PURGE_PATH, 'POST', 'buffered', 'function'],
      ],
    )
  } finally {
    h.restore()
  }
})

test('status reports archived facts without touching disk', async () => {
  const h = harness()
  try {
    const response = await call(h, STATUS_PATH, { search: `?sessionId=${SESSION_ID}` })
    assert.equal(response.status, 200)
    assert.deepEqual(await bodyOf(response), {
      sessionId: SESSION_ID,
      archived: true,
      exists: true,
      bytes: 2048,
      projCache: true,
      resident: false,
    })
    assert.equal(existsSync(h.sessionDir), true)
  } finally {
    h.restore()
  }
})

test('status answers a HEAD probe without a body', async () => {
  const h = harness()
  try {
    const response = await call(h, STATUS_PATH, { method: 'HEAD', search: `?sessionId=${SESSION_ID}` })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
  } finally {
    h.restore()
  }
})

test('resolves the DSH home from the stored log path when no env hint exists', async () => {
  const h = harness({ env: false })
  try {
    const response = await call(h, STATUS_PATH, { search: `?sessionId=${SESSION_ID}` })
    assert.equal(response.status, 200)
    assert.deepEqual(await bodyOf(response), {
      sessionId: SESSION_ID,
      archived: true,
      exists: true,
      bytes: 2048,
      projCache: true,
      resident: false,
    })
  } finally {
    h.restore()
  }
})

test('status rejects a malformed session id', async () => {
  const h = harness()
  try {
    const response = await call(h, STATUS_PATH, { search: '?sessionId=../etc' })
    assert.equal(response.status, 400)
    assert.equal((await bodyOf(response)).error, 'invalid-session-id')
  } finally {
    h.restore()
  }
})

test('purge refuses a session that was never archived', async () => {
  const h = harness({ archived: [] })
  try {
    const response = await call(h, PURGE_PATH, { method: 'POST', body: { sessionId: SESSION_ID } })
    assert.equal(response.status, 409)
    assert.equal((await bodyOf(response)).error, 'not-archived')
    assert.equal(existsSync(h.sessionDir), true)
    assert.deepEqual(h.calls.detach, [])
    assert.deepEqual(h.calls.events, [])
  } finally {
    h.restore()
  }
})

test('purge deletes the slot and its projection cache, settles the registry, then tells Clients', async () => {
  const h = harness()
  try {
    const response = await call(h, PURGE_PATH, { method: 'POST', body: { sessionId: SESSION_ID } })
    const body = await bodyOf(response)
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.bytes, 2048)
    assert.deepEqual(body.removed, ['session-log', 'projection-cache'])
    assert.equal(existsSync(h.sessionDir), false)
    assert.equal(existsSync(h.projCacheFile), false)
    assert.equal(body.settled, true)
    assert.deepEqual(h.calls.detach, [SESSION_ID])
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
    assert.deepEqual(h.calls.events, [['api-session/removed', SESSION_ID]])
  } finally {
    h.restore()
  }
})

test('purge on a session whose log is already gone only settles the registry', async () => {
  const h = harness({ dir: false })
  try {
    // The start sweep settles a leftover mark on its own; let it finish, then put
    // the mark back to exercise the "bytes are gone, only bookkeeping left" branch.
    await new Promise((resolve) => setTimeout(resolve, 30))
    h.archive(SESSION_ID)
    h.calls.unarchive.length = 0
    h.calls.events.length = 0
    const response = await call(h, PURGE_PATH, { method: 'POST', body: { sessionId: SESSION_ID } })
    const body = await bodyOf(response)
    assert.equal(response.status, 200)
    assert.deepEqual(body.removed, ['registry-only'])
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
    assert.deepEqual(h.calls.events, [['api-session/removed', SESSION_ID]])
  } finally {
    h.restore()
  }
})

test('purge leaves the registry alone while the Host still holds the Session', async () => {
  const h = harness()
  try {
    h.calls.resident.add(SESSION_ID)
    const response = await call(h, PURGE_PATH, { method: 'POST', body: { sessionId: SESSION_ID } })
    const body = await bodyOf(response)
    assert.equal(response.status, 200)
    assert.equal(body.settled, false)
    assert.equal(existsSync(h.sessionDir), false)
    // The Session stays archived and attached, so the Client redraws it in its own
    // group instead of moving the ghost to the Ungrouped section.
    assert.deepEqual(h.calls.detach, [])
    assert.deepEqual(h.calls.unarchive, [])
    assert.deepEqual(h.calls.events, [['api-session/removed', SESSION_ID]])
  } finally {
    h.restore()
  }
})

test('a released Session finishes the delete it could not settle', async () => {
  const h = harness()
  try {
    rmSync(h.sessionDir, { recursive: true, force: true })
    assert.deepEqual(h.calls.listeners.map(([event]) => event), ['session/disposed'])
    const [, listener] = h.calls.listeners[0]
    listener({ id: SESSION_ID })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
    assert.deepEqual(h.calls.events, [['api-session/removed', SESSION_ID]])
  } finally {
    h.restore()
  }
})

test('the start sweep settles an archived Session whose log is gone', async () => {
  const h = harness({ dir: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
    assert.deepEqual(h.calls.events, [['api-session/removed', SESSION_ID]])
  } finally {
    h.restore()
  }
})

test('purge is not registered for GET, so Connection never admits one', () => {
  const h = harness()
  try {
    const spec = h.calls.routes.find((route) => route.path === PURGE_PATH)
    assert.deepEqual(spec.methods, ['POST'])
  } finally {
    h.restore()
  }
})
