/**
 * Manifest and module smoke test. Plain script — `node test/smoke.mjs` — so it
 * runs anywhere the rest of the suite runs, without a runner's child processes.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

const manifest = readJson('package.json')

assert.equal(manifest.name, 'dsh-del-chat')
assert.equal(manifest.type, 'module')
assert.equal(manifest.license, 'MIT')
assert.match(manifest.repository.url, /github\.com\/SLZ2025\/dsh-del-chat/)
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch is required')
assert.equal(manifest.dsh.client.platform, 'web')
assert.ok(existsSync(join(root, 'cordis.patch.yml')), 'cordis.patch.yml must exist')
assert.match(read('cordis.patch.yml'), /id: dsh-del-chat/)
assert.match(read('cordis.patch.yml'), /name: dsh-del-chat/)

for (const file of manifest.files) {
  if (file.includes('*')) continue
  assert.ok(existsSync(join(root, file)), `files entry is missing on disk: ${file}`)
}

for (const entry of Object.values(manifest.exports)) {
  if (entry.includes('*')) continue
  assert.ok(existsSync(join(root, entry)), `exports entry is missing on disk: ${entry}`)
}

const host = await import('../index.js')
assert.equal(host.name, 'dsh-del-chat')
assert.deepEqual(host.inject, ['connection'], 'the plugin declares the authenticated Connection it registers on')
assert.equal(typeof host.apply, 'function')

const core = await import('../purge-core.js')
for (const name of [
  'isInside',
  'assertSessionDir',
  'measureDirectory',
  'removeSessionArtifacts',
  'projCachePath',
  'sessionDirOf',
]) {
  assert.equal(typeof core[name], 'function', `purge-core.js must export ${name}`)
}

const client = read('client.js')
assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
assert.match(client, /id: 'dsh-del-chat'/)
assert.match(client, /target: 'session'/)
assert.match(client, /'api\/dsh-del-chat\/'/, 'client must call the authenticated API channel')
assert.ok(client.includes("name: 'shell.overlay'"), 'client must register the overlay dialog')
assert.ok(!client.includes("'/plugin/"), 'no anonymous webServer route may remain on the client')
assert.match(client, /sessions\.refresh\(\)/, 'client must refresh the Session catalog after a purge')

for (const language of ['zh', 'en']) {
  const locale = readJson(`locale/${language}.json`)
  assert.ok(locale.meta.title, `${language} locale needs meta.title`)
  assert.ok(locale.meta.description, `${language} locale needs meta.description`)
  assert.equal(locale.meta.detail, 'docs/DETAIL.md')
  assert.ok(existsSync(join(root, locale.meta.detail)), 'locale detail doc must exist')
}

console.log('smoke: manifest, patch, host, core, client and locales OK')
