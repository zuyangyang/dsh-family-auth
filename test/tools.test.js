import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createRepo } from '../lib/repo.js'
import { createAuthService } from '../lib/auth.js'
import { createWhoamiTool, createBindTool } from '../lib/tools/identity.js'
import { createMemberListTool, createMemberAddTool } from '../lib/tools/members.js'
import { createGrantTool, createRevokeTool, createGrantsTool } from '../lib/tools/grants.js'
import { createAuditTool } from '../lib/tools/audit.js'

/** Tests supply an identity defineTool so no harness is needed. */
const capture = (definition) => definition

function fixture() {
  const store = createStore(mkdtempSync(join(tmpdir(), 'dsh-family-auth-')))
  const repo = createRepo(store)
  const config = { bootstrapOwnerName: '', requireBinding: true, audit: true, skill: true }
  const auth = createAuthService({ repo, config })
  const runtime = { repo, config, auth }
  const defineTool = capture
  return {
    repo,
    auth,
    runtime,
    whoami: createWhoamiTool(runtime, defineTool),
    bind: createBindTool(runtime, defineTool),
    memberList: createMemberListTool(runtime, defineTool),
    memberAdd: createMemberAddTool(runtime, defineTool),
    grant: createGrantTool(runtime, defineTool),
    revoke: createRevokeTool(runtime, defineTool),
    grants: createGrantsTool(runtime, defineTool),
    audit: createAuditTool(runtime, defineTool),
  }
}

const exec = (sessionId) => ({ agent: { session: { id: sessionId } } })

test('whoami on an unbound conversation asks who you are', async () => {
  const f = fixture()
  const out = await f.whoami.execute({}, exec('s1'))
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NEED_IDENTITY')
  assert.match(out.text, /名字/)
})

test('bind creates the owner, then whoami reports it', async () => {
  const f = fixture()
  const bound = await f.bind.execute({ name: '杨' }, exec('s1'))
  assert.equal(bound.ok, true)
  assert.equal(bound.member.role, 'owner')
  assert.equal(bound.created, true)

  const me = await f.whoami.execute({}, exec('s1'))
  assert.equal(me.ok, true)
  assert.match(me.text, /杨/)
  assert.match(me.text, /户主/)
  assert.equal(me.visible, 'all')
})

test('binding an unknown name is refused with the roster', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  const out = await f.bind.execute({ name: '路人' }, exec('s2'))
  assert.equal(out.ok, false)
  assert.equal(out.code, 'UNKNOWN_MEMBER')
  assert.deepEqual(out.members, ['杨'])
})

test('only the owner may add members', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  const added = await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  assert.equal(added.ok, true)
  assert.equal(added.member.role, 'member')

  await f.bind.execute({ name: '小明' }, exec('s2'))
  const denied = await f.memberAdd.execute({ name: '张三' }, exec('s2'))
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'DENIED')
})

test('member_list shows roles', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  const out = await f.memberList.execute({}, exec('s1'))
  assert.equal(out.ok, true)
  assert.equal(out.members.length, 2)
  assert.match(out.text, /户主/)
})

test('a grant widens the grantee read scope, and revoking narrows it back', async () => {
  const f = fixture()
  const owner = (await f.bind.execute({ name: '杨' }, exec('s1'))).member
  await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  const member = (await f.bind.execute({ name: '小明' }, exec('s2'))).member

  assert.deepEqual([...f.auth.readScope(exec('s2'), 'ledger')], [member.id])

  const granted = await f.grant.execute({ grantee: '小明', module: 'ledger' }, exec('s1'))
  assert.equal(granted.ok, true)
  assert.equal(granted.grant.permission, 'read')

  const widened = f.auth.readScope(exec('s2'), 'ledger')
  assert.equal(widened, null)

  const listed = await f.grants.execute({}, exec('s1'))
  assert.equal(listed.ok, true)
  assert.equal(listed.grants.length, 1)

  const revoked = await f.revoke.execute({ grant_id: granted.grant.id }, exec('s1'))
  assert.equal(revoked.ok, true)
  const narrowed = f.auth.readScope(exec('s2'), 'ledger')
  assert.deepEqual([...narrowed], [member.id])
  assert.notEqual(owner.id, member.id)
})

test('a non-owner cannot grant', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  await f.bind.execute({ name: '小明' }, exec('s2'))
  const out = await f.grant.execute({ grantee: '杨' }, exec('s2'))
  assert.equal(out.ok, false)
  assert.equal(out.code, 'DENIED')
})

test('granting to an unknown member is refused', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  const out = await f.grant.execute({ grantee: '路人' }, exec('s1'))
  assert.equal(out.ok, false)
  assert.equal(out.code, 'UNKNOWN_MEMBER')
})

test('an owner-scoped grant only covers the listed members', async () => {
  const f = fixture()
  const owner = (await f.bind.execute({ name: '杨' }, exec('s1'))).member
  await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  await f.memberAdd.execute({ name: '小红' }, exec('s1'))
  await f.bind.execute({ name: '小明' }, exec('s2'))
  const other = (await f.bind.execute({ name: '小红' }, exec('s3'))).member

  const granted = await f.grant.execute(
    { grantee: '小明', module: 'ledger', scope: 'owner', owners: ['杨'] },
    exec('s1'),
  )
  assert.equal(granted.ok, true)
  assert.deepEqual(granted.grant.scope.ownerIds, [owner.id])

  const scope = f.auth.readScope(exec('s2'), 'ledger')
  assert.equal(scope.has(owner.id), true)
  assert.equal(scope.has(other.id), false)
})

test('a bad expiry date is reported, not silently ignored', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  const out = await f.grant.execute({ grantee: '小明', expires_at: '下个月' }, exec('s1'))
  assert.equal(out.ok, false)
  assert.equal(out.code, 'BAD_DATE')
})

test('the audit log is owner only and records denies', async () => {
  const f = fixture()
  await f.bind.execute({ name: '杨' }, exec('s1'))
  await f.memberAdd.execute({ name: '小明' }, exec('s1'))
  await f.bind.execute({ name: '小明' }, exec('s2'))

  await f.memberAdd.execute({ name: '张三' }, exec('s2'))

  const ownerView = await f.audit.execute({ only_denied: true }, exec('s1'))
  assert.equal(ownerView.ok, true)
  assert.ok(ownerView.entries.length >= 1)

  const memberView = await f.audit.execute({}, exec('s2'))
  assert.equal(memberView.ok, false)
  assert.equal(memberView.code, 'DENIED')
})

test('unbound conversations are refused by every data tool', async () => {
  const f = fixture()
  for (const tool of [f.memberList, f.memberAdd, f.grant, f.revoke, f.grants, f.audit]) {
    const out = await tool.execute({}, exec('nobody'))
    assert.equal(out.ok, false, tool.name)
    assert.equal(out.code, 'NEED_IDENTITY', tool.name)
  }
})
