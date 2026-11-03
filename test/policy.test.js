import { test } from 'node:test'
import assert from 'node:assert/strict'

import { can, allowedOwnerIds, foldGrants, REASON } from '../lib/policy.js'

const owner = { id: 'u_owner', role: 'owner', status: 'active' }
const member = { id: 'u_member', role: 'member', status: 'active' }
const other = { id: 'u_other', role: 'member', status: 'active' }
const disabled = { id: 'u_off', role: 'member', status: 'disabled' }

function grant(over = {}) {
  return {
    type: 'grant',
    id: 'g_1',
    granteeId: 'u_member',
    module: 'ledger',
    permission: 'read',
    scope: { kind: 'all' },
    grantedBy: 'u_owner',
    grantedAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    expiresAt: null,
    ...over,
  }
}

test('unknown actor is refused', () => {
  assert.deepEqual(can({ actor: null, action: 'read', module: 'ledger' }), {
    allow: false,
    reason: REASON.NO_ACTOR,
  })
})

test('disabled actor is refused even for its own data', () => {
  const decision = can({ actor: disabled, action: 'read', module: 'ledger', resourceOwnerId: 'u_off' })
  assert.equal(decision.allow, false)
  assert.equal(decision.reason, REASON.INACTIVE)
})

test('owner bypasses grants entirely', () => {
  const decision = can({ actor: owner, action: 'manage', module: 'anything' })
  assert.equal(decision.allow, true)
  assert.equal(decision.reason, REASON.OWNER)
})

test('you may always touch your own rows without a grant', () => {
  for (const action of ['read', 'write', 'manage']) {
    const decision = can({ actor: member, action, module: 'ledger', resourceOwnerId: 'u_member' })
    assert.equal(decision.allow, true, action)
    assert.equal(decision.reason, REASON.SELF)
  }
})

test('someone else\'s row needs a grant', () => {
  const decision = can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_other' })
  assert.equal(decision.allow, false)
  assert.equal(decision.reason, REASON.NO_GRANT)
})

test('a read grant allows reading but not writing', () => {
  const grants = [grant({ scope: { kind: 'owner', ownerIds: ['u_other'] } })]
  const read = can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_other', grants })
  assert.equal(read.allow, true)
  assert.equal(read.grantId, 'g_1')
  const write = can({ actor: member, action: 'write', module: 'ledger', resourceOwnerId: 'u_other', grants })
  assert.equal(write.allow, false)
})

test('a write grant implies read too', () => {
  const grants = [grant({ permission: 'write' })]
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_other', grants }).allow, true)
  assert.equal(can({ actor: member, action: 'write', module: 'ledger', resourceOwnerId: 'u_other', grants }).allow, true)
  assert.equal(can({ actor: member, action: 'manage', module: 'ledger', resourceOwnerId: 'u_other', grants }).allow, false)
})

test('module wildcard covers every module', () => {
  const grants = [grant({ module: '*' })]
  assert.equal(can({ actor: member, action: 'read', module: 'health', resourceOwnerId: 'u_other', grants }).allow, true)
})

test('scope limits a grant to named owners', () => {
  const grants = [grant({ scope: { kind: 'owner', ownerIds: ['u_other'] } })]
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_third', grants }).allow, false)
})

test('records scope matches on record id, not owner', () => {
  const grants = [grant({ scope: { kind: 'records', recordIds: ['e_42'] } })]
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_third', resourceId: 'e_42', grants }).allow, true)
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_third', resourceId: 'e_43', grants }).allow, false)
})

test('revoked grants stop working', () => {
  const grants = [grant({ revokedAt: '2026-02-01T00:00:00.000Z' })]
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_other', grants }).allow, false)
})

test('expired grants stop working', () => {
  const grants = [grant({ expiresAt: '2026-02-01T00:00:00.000Z' })]
  const now = new Date('2026-03-01T00:00:00.000Z')
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_other', grants, now }).allow, false)
})

test('a grant for someone else does not apply', () => {
  const grants = [grant({ granteeId: 'u_other' })]
  assert.equal(can({ actor: member, action: 'read', module: 'ledger', resourceOwnerId: 'u_owner', grants }).allow, false)
})

test('allowedOwnerIds is null for the owner (unrestricted)', () => {
  assert.equal(allowedOwnerIds({ actor: owner, module: 'ledger' }), null)
})

test('allowedOwnerIds always contains self', () => {
  const ids = allowedOwnerIds({ actor: member, module: 'ledger' })
  assert.deepEqual([...ids], ['u_member'])
})

test('allowedOwnerIds widens with owner-scope grants but not records scope', () => {
  const grants = [
    grant({ id: 'g_a', scope: { kind: 'owner', ownerIds: ['u_other'] } }),
    grant({ id: 'g_b', scope: { kind: 'records', recordIds: ['e_1'] } }),
  ]
  const ids = allowedOwnerIds({ actor: member, module: 'ledger', grants })
  assert.deepEqual([...ids].sort(), ['u_member', 'u_other'])
})

test('allowedOwnerIds returns null when a grant is module-wide', () => {
  const grants = [grant({ scope: { kind: 'all' } })]
  assert.equal(allowedOwnerIds({ actor: member, module: 'ledger', grants }), null)
})

test('allowedOwnerIds is empty for an unknown actor', () => {
  assert.equal(allowedOwnerIds({ actor: null, module: 'ledger' }).size, 0)
})

test('foldGrants keeps history and applies revocations', () => {
  const folded = foldGrants([
    { type: 'grant', id: 'g_1', scope: { kind: 'all' } },
    { type: 'grant', id: 'g_2', scope: { kind: 'all' } },
    { type: 'revoke', grantId: 'g_1', at: '2026-02-02T00:00:00.000Z' },
  ])
  assert.equal(folded.length, 2)
  assert.equal(folded.find((g) => g.id === 'g_1').revokedAt, '2026-02-02T00:00:00.000Z')
  assert.equal(folded.find((g) => g.id === 'g_2').revokedAt, null)
})
