import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  assertSessionDir,
  isInside,
  measureDirectory,
  projCachePath,
  removeSessionArtifacts,
  sessionDirOf,
} from '../purge-core.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-del-chat-'))
  const sessionsRoot = join(home, 'sessions')
  const project = join(sessionsRoot, '--D-workspace--')
  const sessionDir = join(project, 'session-aaaa')
  const projCacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(projCacheRoot, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7))
  const projCacheFile = projCachePath(home, 'session-aaaa')
  writeFileSync(projCacheFile, '{"projection":true}')
  return { home, sessionsRoot, sessionDir, projCacheRoot, projCacheFile }
}

test('isInside rejects siblings and parent escapes', () => {
  assert.equal(isInside('D:/a/b', 'D:/a/b/c'), true)
  assert.equal(isInside('D:/a/b', 'D:/a/b'), true)
  assert.equal(isInside('D:/a/b', 'D:/a/bc'), false)
  assert.equal(isInside('D:/a/b', 'D:/a'), false)
})

test('assertSessionDir only accepts a slot named after the session id', () => {
  const { sessionsRoot, sessionDir } = fixture()
  assert.doesNotThrow(() => assertSessionDir(sessionsRoot, sessionDir, 'session-aaaa'))
  assert.throws(() => assertSessionDir(sessionsRoot, sessionDir, 'session-bbbb'), /does not match/)
  assert.throws(() => assertSessionDir(sessionsRoot, sessionDir, 'session-aaaa '), /does not match/)
  assert.throws(() => assertSessionDir(sessionsRoot, sessionsRoot, 'session-aaaa'), /does not match/)
})

test('assertSessionDir refuses a slot outside the persistence root', () => {
  const { sessionsRoot, sessionDir } = fixture()
  assert.throws(() => assertSessionDir(join(sessionsRoot, 'other'), sessionDir, 'session-aaaa'), /outside/)
})

test('measureDirectory counts nested files and tolerates a missing tree', () => {
  const { sessionDir, home } = fixture()
  assert.equal(measureDirectory(sessionDir), 2048)
  assert.equal(measureDirectory(join(home, 'nope')), 0)
})

test('removeSessionArtifacts deletes the slot and the projection cache', () => {
  const { sessionsRoot, sessionDir, projCacheRoot, projCacheFile } = fixture()
  const result = removeSessionArtifacts({
    sessionId: 'session-aaaa',
    sessionsRoot,
    sessionDir,
    projCacheRoot,
    projCacheFile,
  })
  assert.equal(result.bytes, 2048)
  assert.deepEqual(result.removed, ['session-log', 'projection-cache'])
  assert.equal(existsSync(sessionDir), false)
  assert.equal(existsSync(projCacheFile), false)
  assert.deepEqual(readdirSync(join(sessionsRoot, '--D-workspace--')), [])
})

test('removeSessionArtifacts refuses before deleting anything', () => {
  const { sessionsRoot, sessionDir, projCacheRoot, projCacheFile } = fixture()
  assert.throws(
    () =>
      removeSessionArtifacts({
        sessionId: 'session-zzzz',
        sessionsRoot,
        sessionDir,
        projCacheRoot,
        projCacheFile,
      }),
    /does not match/,
  )
  assert.equal(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), true)
  assert.equal(existsSync(projCacheFile), true)
})

test('removeSessionArtifacts skips a projection cache outside its root', () => {
  const { sessionsRoot, sessionDir, projCacheRoot } = fixture()
  const outsider = join(sessionDir, 'outside.json')
  writeFileSync(outsider, '{}')
  const result = removeSessionArtifacts({
    sessionId: 'session-aaaa',
    sessionsRoot,
    sessionDir,
    projCacheRoot,
    projCacheFile: outsider,
  })
  assert.deepEqual(result.skipped, ['projection-cache-outside-root'])
  assert.deepEqual(result.removed, ['session-log'])
})

test('sessionDirOf maps a log path to its slot', () => {
  const slot = sessionDirOf(join('D:', 'h', 'sessions', '--x--', 'session-aaaa', 'session.v4.jsonl.zstd'))
  assert.equal(basename(slot), 'session-aaaa')
  assert.equal(sessionDirOf(undefined), null)
  assert.equal(sessionDirOf(''), null)
})
