import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { defaultDataDir, normalizeConfig } from '../lib/config.js'

test('two DSH homes never share one member table', () => {
  // The isolation story in one assertion: a second profile sets its own
  // DSH_HOME and gets its own authorization state without configuring anything.
  const a = defaultDataDir({ DSH_HOME: '/tmp/home-a' })
  const b = defaultDataDir({ DSH_HOME: '/tmp/home-b' })
  assert.equal(a, join('/tmp/home-a', 'family-auth'))
  assert.equal(b, join('/tmp/home-b', 'family-auth'))
  assert.notEqual(a, b)
})

test('without DSH_HOME it falls back to the desktop home', () => {
  assert.equal(defaultDataDir({}), join(homedir(), '.dsh', 'family-auth'))
  assert.equal(defaultDataDir({ DSH_HOME: '   ' }), join(homedir(), '.dsh', 'family-auth'))
})

test('an unconfigured profile resolves to its own default', () => {
  assert.equal(normalizeConfig({}).dataDir, defaultDataDir())
  assert.equal(normalizeConfig({ dataDir: '~/auth' }).dataDir, join(homedir(), 'auth'))
})
