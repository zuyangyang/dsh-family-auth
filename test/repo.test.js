import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createRepo, foldUsers, nameKey } from '../lib/repo.js'
import { claimIdentity, IDENTITY_ERROR } from '../lib/identity.js'

function fixture(config = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'dsh-family-auth-')))
  return { store, repo: createRepo(store), config: { bootstrapOwnerName: '', ...config } }
}

test('names are unique case- and space-insensitively', () => {
  const { repo } = fixture()
  repo.addUser({ name: '杨' })
  assert.throws(() => repo.addUser({ name: '  杨 ' }), (error) => error.code === 'NAME_TAKEN')
})

test('an empty name is refused', () => {
  const { repo } = fixture()
  assert.throws(() => repo.addUser({ name: '   ' }), (error) => error.code === 'EMPTY_NAME')
})

test('updateUser patches role and status', () => {
  const { repo } = fixture()
  const user = repo.addUser({ name: '小明' })
  repo.updateUser(user.id, { status: 'disabled' })
  assert.equal(repo.findUserById(user.id).status, 'disabled')
})

test('the first claim bootstraps the owner when no bootstrap name is set', () => {
  const { repo, config } = fixture()
  const result = claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  assert.equal(result.created, true)
  assert.equal(result.actor.role, 'owner')
  assert.equal(repo.actorForSession('s1').name, '杨')
})

test('only the configured bootstrap name may claim ownership', () => {
  const { repo, config } = fixture({ bootstrapOwnerName: '杨' })
  assert.throws(
    () => claimIdentity({ repo, sessionId: 's1', name: '路人', config }),
    (error) => error.code === IDENTITY_ERROR.UNKNOWN_MEMBER,
  )
  const result = claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  assert.equal(result.actor.role, 'owner')
})

test('a known member binds without creating a second record', () => {
  const { repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  const before = repo.users().length
  const result = claimIdentity({ repo, sessionId: 's2', name: '杨', config })
  assert.equal(result.created, false)
  assert.equal(repo.users().length, before)
  assert.equal(repo.actorForSession('s2').name, '杨')
})

test('an unknown name is refused once members exist, and the roster comes back', () => {
  const { repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  try {
    claimIdentity({ repo, sessionId: 's2', name: '陌生人', config })
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, IDENTITY_ERROR.UNKNOWN_MEMBER)
    assert.deepEqual(error.members, ['杨'])
  }
})

test('a disabled member cannot claim a session', () => {
  const { repo, config } = fixture()
  const owner = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  const other = repo.addUser({ name: '小明' })
  repo.updateUser(other.id, { status: 'disabled' })
  assert.throws(
    () => claimIdentity({ repo, sessionId: 's2', name: '小明', config }),
    (error) => error.code === IDENTITY_ERROR.DISABLED_MEMBER,
  )
  assert.equal(repo.actorForSession('s1').id, owner.id)
})

test('rebinding a session to another member is reported', () => {
  const { repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  repo.addUser({ name: '小明' })
  const result = claimIdentity({ repo, sessionId: 's1', name: '小明', config })
  assert.equal(result.rebound, true)
  assert.equal(repo.actorForSession('s1').name, '小明')
})

test('unbind removes the session actor', () => {
  const { repo, config } = fixture()
  claimIdentity({ repo, sessionId: 's1', name: '杨', config })
  assert.equal(repo.unbind('s1'), true)
  assert.equal(repo.actorForSession('s1'), null)
})

test('a disabled member loses its bound sessions', () => {
  const { repo, config } = fixture()
  const actor = claimIdentity({ repo, sessionId: 's1', name: '杨', config }).actor
  repo.updateUser(actor.id, { status: 'disabled' })
  assert.equal(repo.actorForSession('s1'), null)
})

test('grants fold through the repo and revocations stick', () => {
  const { repo } = fixture()
  repo.addUser({ name: '杨', role: 'owner' })
  const giver = repo.findUserByName('杨')
  const member = repo.addUser({ name: '小明' })
  const grant = repo.addGrant(
    { granteeId: member.id, module: 'ledger', permission: 'read', scope: { kind: 'all' } },
    { grantedBy: giver.id },
  )
  assert.equal(repo.grantsFor(member.id).length, 1)
  repo.revokeGrant(grant.id, giver.id)
  assert.equal(repo.grantsFor(member.id).length, 0)
  assert.equal(repo.grants().length, 1)
})

test('audit decisions keep their context', () => {
  const { repo } = fixture()
  repo.auditDecision({ module: 'ledger', action: 'read', allow: false, reason: 'no-grant' })
  const [entry] = repo.auditLog()
  assert.equal(entry.allow, false)
  assert.equal(entry.reason, 'no-grant')
  assert.ok(entry.at)
})

test('foldUsers applies updates in order', () => {
  const users = foldUsers([
    { type: 'add', id: 'u_1', name: 'a', status: 'active' },
    { type: 'update', id: 'u_1', patch: { status: 'disabled' }, at: 'x' },
  ])
  assert.equal(users[0].status, 'disabled')
})

test('nameKey normalises', () => {
  assert.equal(nameKey('  Zhang  San '), 'zhang san')
})
