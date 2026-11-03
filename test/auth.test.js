import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createRepo } from '../lib/repo.js'
import { claimIdentity } from '../lib/identity.js'
import { createAuthService, AUTH_ERROR, AuthorizationError } from '../lib/auth.js'

function fixture(config = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'dsh-family-auth-')))
  const repo = createRepo(store)
  const normalized = { bootstrapOwnerName: '', requireBinding: true, audit: true, ...config }
  const auth = createAuthService({ repo, config: normalized })
  return { store, repo, auth, config: normalized }
}

const exec = (sessionId) => ({ agent: { session: { id: sessionId } } })

test('a missing session is refused', () => {
  const { auth } = fixture()
  assert.throws(() => auth.mustWrite({}, 'ledger'), (error) => error.code === AUTH_ERROR.NO_SESSION)
})

test('an unbound session is refused and told the roster', () => {
  const { auth, repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  try {
    auth.mustWrite(exec('s2'), 'ledger')
    assert.fail('should have thrown')
  } catch (error) {
    assert.ok(error instanceof AuthorizationError)
    assert.equal(error.code, AUTH_ERROR.NEED_IDENTITY)
    assert.deepEqual(error.members, ['杨'])
  }
})

test('a bound member may write and gets its owner id', () => {
  const { auth, repo, config } = fixture()
  const actor = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  const stamp = auth.mustWrite(exec('s1'), 'ledger')
  assert.equal(stamp.ownerId, actor.id)
  assert.equal(stamp.actor.name, '杨')
})

test('a member may touch its own row', () => {
  const { auth, repo, config } = fixture()
  const owner = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  const member = repo.addUser({ name: '小明' })
  claimIdentity({ repo, sessionId: 's2', name: '小明', config })
  const result = auth.mustAccess(exec('s2'), 'ledger', 'write', { ownerId: member.id })
  assert.equal(result.actor.id, member.id)
  assert.equal(result.reason, 'self')
  assert.ok(owner.id)
})

test('reading someone else\'s row without a grant is refused', () => {
  const { auth, repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  repo.addUser({ name: '小明' })
  claimIdentity({ repo, sessionId: 's2', name: '小明', config })
  assert.throws(
    () => auth.mustAccess(exec('s2'), 'ledger', 'read', { ownerId: repo.findUserByName('杨').id }),
    (error) => error.code === AUTH_ERROR.DENIED,
  )
})

test('a grant makes another member\'s row readable', () => {
  const { auth, repo, config } = fixture()
  const owner = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  const member = repo.addUser({ name: '小明' })
  claimIdentity({ repo, sessionId: 's2', name: '小明', config })
  repo.addGrant(
    { granteeId: member.id, module: 'ledger', permission: 'read', scope: { kind: 'all' } },
    { grantedBy: owner.id },
  )
  const result = auth.mustAccess(exec('s2'), 'ledger', 'read', { ownerId: owner.id })
  assert.equal(result.reason, 'grant')
})

test('readScope is unrestricted for the owner', () => {
  const { auth, repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  assert.equal(auth.readScope(exec('s1'), 'ledger'), null)
})

test('readScope is self-only for a plain member', () => {
  const { auth, repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  const member = repo.addUser({ name: '小明' })
  const binding = claimIdentity({ repo, sessionId: 's2', name: '小明', config })
  assert.equal(binding.actor.id, member.id)
  const scope = auth.readScope(exec('s2'), 'ledger')
  assert.deepEqual([...scope], [member.id])
})

test('readScope widens with an owner-scope grant', () => {
  const { auth, repo, config } = fixture()
  const owner = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  const member = repo.addUser({ name: '小明' })
  claimIdentity({ repo, sessionId: 's2', name: '小明', config })
  repo.addGrant(
    { granteeId: member.id, module: 'ledger', permission: 'read', scope: { kind: 'owner', ownerIds: [owner.id] } },
    { grantedBy: owner.id },
  )
  const scope = auth.readScope(exec('s2'), 'ledger')
  assert.deepEqual([...scope].sort(), [actor(owner), member.id].sort())
})

function actor(user) {
  return user.id
}

test('readScope throws when binding is required and absent', () => {
  const { auth } = fixture()
  assert.throws(() => auth.readScope(exec('nobody'), 'ledger'), (error) => error.code === AUTH_ERROR.NEED_IDENTITY)
})

test('readScope may be opened deliberately with requireBinding off', () => {
  const { auth } = fixture({ requireBinding: false })
  assert.equal(auth.readScope(exec('nobody'), 'ledger'), null)
})

test('every decision is written to the audit table', () => {
  const { auth, repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  auth.mustWrite(exec('s1'), 'ledger')
  auth.readScope(exec('s1'), 'ledger')
  const entries = repo.auditLog()
  assert.equal(entries.length, 2)
  assert.equal(entries[0].action, 'write')
  assert.equal(entries[1].action, 'read-scope')
  assert.ok(entries[0].sessionId)
})

test('auditing can be turned off', () => {
  const { auth, repo, config } = fixture({ audit: false })
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  auth.mustWrite(exec('s1'), 'ledger')
  assert.equal(repo.auditLog().length, 0)
})

test('defineModule records metadata and rejects a blank name', () => {
  const { auth } = fixture()
  const module = auth.defineModule({ name: 'ledger', permissions: ['read', 'write'] })
  assert.equal(module.name, 'ledger')
  assert.equal(module.ownable, true)
  assert.deepEqual(auth.listModules().map((m) => m.name), ['ledger'])
  assert.throws(() => auth.defineModule({}), (error) => error.code === AUTH_ERROR.UNKNOWN_MODULE)
})

test('a disabled member loses access mid-session', () => {
  const { auth, repo, config } = fixture()
  const actor = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  repo.updateUser(actor.id, { status: 'disabled' })
  assert.throws(() => auth.mustWrite(exec('s1'), 'ledger'), (error) => error.code === AUTH_ERROR.NEED_IDENTITY)
})

// ---------------------------------------------------------------- fallback

test('unbound writes land in the shared bucket when a fallback owner is set', () => {
  const { auth } = fixture({ fallbackOwner: 'default' })
  const stamp = auth.mustWrite(exec('anonymous'), 'ledger')
  assert.equal(stamp.ownerId, 'default')
  assert.equal(stamp.anonymous, true)
  assert.equal(stamp.actor, null)
})

test('unbound writes are refused when the fallback is switched off', () => {
  const { auth } = fixture({ fallbackOwner: '' })
  assert.throws(() => auth.mustWrite(exec('anonymous'), 'ledger'),
    (error) => error.code === AUTH_ERROR.NEED_IDENTITY)
})

test('an unbound conversation can read the shared bucket and nothing else', () => {
  const { auth } = fixture({ fallbackOwner: 'default' })
  const scope = auth.readScope(exec('anonymous'), 'ledger')
  assert.deepEqual([...scope], ['default'])
})

test('every member sees the shared bucket alongside their own rows', () => {
  const { auth, repo, config } = fixture({ fallbackOwner: 'default' })
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  const member = repo.addUser({ name: '小明' })
  claimIdentity({ repo, sessionId: 's2', name: '小明', config })
  const scope = auth.readScope(exec('s2'), 'ledger')
  assert.deepEqual([...scope].sort(), ['default', member.id].sort())
})

test('the owner still sees everything, shared bucket included', () => {
  const { auth, repo, config } = fixture({ fallbackOwner: 'default' })
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  assert.equal(auth.readScope(exec('s1'), 'ledger'), null)
})

test('ownerLabel turns ids into names and the bucket into 未识别', () => {
  const { auth, repo, config } = fixture({ fallbackOwner: 'default' })
  const owner = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  assert.equal(auth.ownerLabel(owner.id), '杨')
  assert.equal(auth.ownerLabel('default'), '未识别')
  assert.equal(auth.ownerLabel(null), '未识别')
})

test('anonymous writes are audited as such', () => {
  const { auth, repo } = fixture({ fallbackOwner: 'default' })
  auth.mustWrite(exec('anonymous'), 'ledger')
  const [entry] = repo.auditLog()
  assert.equal(entry.reason, 'anonymous-fallback')
})
