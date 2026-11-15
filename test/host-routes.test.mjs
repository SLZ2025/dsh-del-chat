import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const SESSION_ID = 'session-aaaa'

/** A Host context stub with just the seam this plugin touches. */
function harness({ archived = [SESSION_ID], dir = true } = {}) {
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
  const calls = { detach: [], unarchive: [], routes: [] }
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
      if (!dir || id !== SESSION_ID) return undefined
      return { location: { path: join(sessionDir, 'session.v4.jsonl.zstd') } }
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    webServer: {
      register(spec) {
        calls.routes.push(spec)
        return () => {}
      },
    },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') return persistence
      return undefined
    },
  }

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  apply(ctx)
  return {
    home,
    sessionDir,
    projCacheFile: join(projCacheRoot, `${SESSION_ID}.json`),
    calls,
    handler: calls.routes[0].resource,
    prefix: calls.routes[0].path,
    kind: calls.routes[0].kind,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

const base = 'http://dsh.test/plugin/dsh-del-chat/'

test('registers one prefix route', () => {
  const h = harness()
  try {
    assert.equal(h.kind, 'prefix')
    assert.equal(h.prefix, '/plugin/dsh-del-chat/')
    assert.equal(typeof h.handler, 'function')
  } finally {
    h.restore()
  }
})

test('status reports archived facts without touching disk', async () => {
  const h = harness()
  try {
    const response = await h.handler(new Request(`${base}status?sessionId=${SESSION_ID}`))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { sessionId: SESSION_ID, archived: true, exists: true, bytes: 2048, projCache: true })
    assert.equal(existsSync(h.sessionDir), true)
  } finally {
    h.restore()
  }
})

test('status rejects a malformed session id', async () => {
  const h = harness()
  try {
    const response = await h.handler(new Request(`${base}status?sessionId=../etc`))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'invalid-session-id')
  } finally {
    h.restore()
  }
})

test('purge refuses a session that was never archived', async () => {
  const h = harness({ archived: [] })
  try {
    const response = await h.handler(
      new Request(`${base}purge`, { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID }) }),
    )
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'not-archived')
    assert.equal(existsSync(h.sessionDir), true)
    assert.deepEqual(h.calls.detach, [])
  } finally {
    h.restore()
  }
})

test('purge settles the registry then deletes the slot and its projection cache', async () => {
  const h = harness()
  try {
    const response = await h.handler(
      new Request(`${base}purge`, { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID }) }),
    )
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.bytes, 2048)
    assert.deepEqual(body.removed, ['session-log', 'projection-cache'])
    assert.equal(existsSync(h.sessionDir), false)
    assert.equal(existsSync(h.projCacheFile), false)
    assert.deepEqual(h.calls.detach, [SESSION_ID])
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
  } finally {
    h.restore()
  }
})

test('purge on a session whose log is already gone only settles the registry', async () => {
  const h = harness({ dir: false })
  try {
    const response = await h.handler(
      new Request(`${base}purge`, { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID }) }),
    )
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body.removed, ['registry-only'])
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
  } finally {
    h.restore()
  }
})

test('purge rejects GET and unknown actions', async () => {
  const h = harness()
  try {
    const wrongMethod = await h.handler(new Request(`${base}purge?sessionId=${SESSION_ID}`))
    assert.equal(wrongMethod.status, 405)
    const missing = await h.handler(new Request(`${base}nope`))
    assert.equal(missing.status, 404)
  } finally {
    h.restore()
  }
})
