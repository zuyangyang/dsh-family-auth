import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { normalizeName, clampInt, newId, expandHome } from '../lib/util.js'

function tempStore() {
  return createStore(mkdtempSync(join(tmpdir(), 'dsh-family-auth-')))
}

test('append then read returns records in file order', () => {
  const store = tempStore()
  store.append('users', { type: 'add', id: 'u_1' })
  store.append('users', { type: 'add', id: 'u_2' })
  const records = store.read('users')
  assert.deepEqual(records.map((r) => r.id), ['u_1', 'u_2'])
})

test('reading a missing table yields an empty array', () => {
  const store = tempStore()
  assert.deepEqual(store.read('grants'), [])
})

test('a truncated trailing line does not break the read', () => {
  const store = tempStore()
  store.append('users', { type: 'add', id: 'u_1' })
  appendFileSync(store.path('users'), '{"type":"add","id":"u_2"', 'utf8')
  const records = store.read('users')
  assert.deepEqual(records.map((r) => r.id), ['u_1'])
})

test('table files are created owner-only', () => {
  const store = tempStore()
  store.append('users', { type: 'add', id: 'u_1' })
  const mode = statSync(store.path('users')).mode & 0o777
  assert.equal(mode, 0o600)
  assert.ok(readFileSync(store.path('users'), 'utf8').endsWith('\n'))
})

test('normalizeName trims and collapses whitespace', () => {
  assert.equal(normalizeName('  杨  '), '杨')
  assert.equal(normalizeName('张  三'), '张 三')
  assert.equal(normalizeName(undefined), '')
})

test('clampInt falls back on unusable input', () => {
  assert.equal(clampInt('5', 0, 10, 1), 5)
  assert.equal(clampInt(99, 0, 10, 1), 10)
  assert.equal(clampInt('x', 0, 10, 1), 1)
})

test('newId is prefixed and unique enough', () => {
  const a = newId('u')
  const b = newId('u')
  assert.ok(a.startsWith('u_'))
  assert.notEqual(a, b)
})

test('expandHome leaves non-strings alone', () => {
  assert.equal(expandHome(null), null)
  assert.equal(expandHome('/abs/path'), '/abs/path')
  assert.ok(expandHome('~/x').endsWith('/x'))
})
