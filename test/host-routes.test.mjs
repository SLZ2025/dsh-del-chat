import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../index.js'

const SESSION_ID = 'session-aaaa'
const PREFIX = '/plugin/dsh-del-chat/'

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

/**
 * Drive one registered node `handler` route the way the Host web server does and
 * collect the response it writes.
 */
function call(h, action, { method = 'GET', body, search = '' } = {}) {
  const spec = h.calls.routes.find((route) => route.path === PREFIX + action)
  assert.ok(spec, `no route registered for ${PREFIX}${action}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = Readable.from(chunks)
  request.method = method
  request.url = PREFIX + action + search
  request.headers = { 'content-type': 'application/json' }

  let settle
  const done = new Promise((resolve) => {
    settle = resolve
  })
  const response = {
    statusCode: 0,
    headers: {},
    text: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      this.text = chunk === undefined ? '' : String(chunk)
      settle(this)
      return this
    },
  }
  spec.handler(request, response)
  return done
}

const readJson = (response) => JSON.parse(response.text)

test('registers one exact handler route per action', () => {
  const h = harness()
  try {
    assert.deepEqual(
      h.calls.routes.map((route) => [route.kind, route.path, typeof route.handler]),
      [
        ['exact', `${PREFIX}status`, 'function'],
        ['exact', `${PREFIX}purge`, 'function'],
      ],
    )
  } finally {
    h.restore()
  }
})

test('status reports archived facts without touching disk', async () => {
  const h = harness()
  try {
    const response = await call(h, 'status', { search: `?sessionId=${SESSION_ID}` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(readJson(response), {
      sessionId: SESSION_ID,
      archived: true,
      exists: true,
      bytes: 2048,
      projCache: true,
    })
    assert.equal(existsSync(h.sessionDir), true)
  } finally {
    h.restore()
  }
})

test('resolves the DSH home from the stored log path when no env hint exists', async () => {
  const h = harness({ env: false })
  try {
    const response = await call(h, 'status', { search: `?sessionId=${SESSION_ID}` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(readJson(response), {
      sessionId: SESSION_ID,
      archived: true,
      exists: true,
      bytes: 2048,
      projCache: true,
    })
  } finally {
    h.restore()
  }
})

test('status rejects a malformed session id', async () => {
  const h = harness()
  try {
    const response = await call(h, 'status', { search: '?sessionId=../etc' })
    assert.equal(response.statusCode, 400)
    assert.equal(readJson(response).error, 'invalid-session-id')
  } finally {
    h.restore()
  }
})

test('purge refuses a session that was never archived', async () => {
  const h = harness({ archived: [] })
  try {
    const response = await call(h, 'purge', { method: 'POST', body: { sessionId: SESSION_ID } })
    assert.equal(response.statusCode, 409)
    assert.equal(readJson(response).error, 'not-archived')
    assert.equal(existsSync(h.sessionDir), true)
    assert.deepEqual(h.calls.detach, [])
  } finally {
    h.restore()
  }
})

test('purge settles the registry then deletes the slot and its projection cache', async () => {
  const h = harness()
  try {
    const response = await call(h, 'purge', { method: 'POST', body: { sessionId: SESSION_ID } })
    const body = readJson(response)
    assert.equal(response.statusCode, 200)
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
    const response = await call(h, 'purge', { method: 'POST', body: { sessionId: SESSION_ID } })
    const body = readJson(response)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(body.removed, ['registry-only'])
    assert.deepEqual(h.calls.unarchive, [SESSION_ID])
  } finally {
    h.restore()
  }
})

test('purge rejects GET', async () => {
  const h = harness()
  try {
    const response = await call(h, 'purge', { search: `?sessionId=${SESSION_ID}` })
    assert.equal(response.statusCode, 405)
    assert.equal(readJson(response).error, 'method-not-allowed')
  } finally {
    h.restore()
  }
})
