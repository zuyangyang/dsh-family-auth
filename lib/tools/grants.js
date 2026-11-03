/**
 * `family_grant`, `family_revoke` and `family_grants`.
 *
 * Granting is where a mistake leaks data, so the defaults are narrow: read-only,
 * explicit scope, and only the owner (or a module manager) may hand one out.
 * @module dsh-family-auth/tools/grants
 */

import { describeGrant } from './identity.js'
import { denyText, guarded, rosterLine } from './shared.js'

const identityDefineTool = (definition) => definition
const PERMISSIONS = ['read', 'write', 'manage']
const SCOPES = ['all', 'owner', 'records']

/**
 * Whether an actor may hand out grants for a module: the owner, or someone the
 * owner made a module manager (a live `manage` grant covering the whole module).
 * @param {object} actor - resolved member.
 * @param {string} module - module name.
 * @param {object[]} liveGrants - current live grants.
 * @returns {boolean} true when allowed.
 */
function canAdminister(actor, module, liveGrants) {
  if (actor.role === 'owner') return true
  return liveGrants.some((grant) =>
    grant.granteeId === actor.id
    && (grant.module === module || grant.module === '*')
    && grant.permission === 'manage'
    && grant.scope?.kind === 'all')
}

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_grant` tool definition.
 */
export function createGrantTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_grant',
    description: 'Let another member read (or write) your records in one module. '
      + 'Defaults to read-only over the whole module. Owner or module manager only.',
    parameters: {
      grantee: { type: 'string', required: true, description: '被授权的成员名字。' },
      module: { type: 'string', description: '模块名，比如 ledger、diary、health；默认 *（全部）。' },
      permission: { type: 'string', description: 'read（默认）、write 或 manage。' },
      scope: { type: 'string', description: 'all（默认，全部记录）、owner（指定成员）或 records（指定记录）。' },
      owners: { type: 'array', items: { type: 'string' }, description: 'scope=owner 时，被授权的成员名字列表。' },
      records: { type: 'array', items: { type: 'string' }, description: 'scope=records 时，记录 id 列表。' },
      expires_at: { type: 'string', description: '到期时间，ISO 日期，例如 2026-12-31。' },
      note: { type: 'string', description: '备注。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      const actor = runtime.auth.requireActor(exec)
      const module = typeof args.module === 'string' && args.module.trim().length > 0 ? args.module.trim() : '*'
      const liveGrants = runtime.repo.liveGrants()
      if (!canAdminister(actor, module, liveGrants)) {
        runtime.auth.record(exec, module, 'grant', { allow: false, reason: 'not-owner-or-manager' })
        return denyText('只有户主（或这个模块的管理者）能授权。')
      }

      const permission = PERMISSIONS.includes(args.permission) ? args.permission : 'read'
      const scopeKind = SCOPES.includes(args.scope) ? args.scope : 'all'

      const grantee = runtime.repo.findUserByName(args.grantee)
      if (!grantee) {
        return {
          ok: false,
          code: 'UNKNOWN_MEMBER',
          text: '「' + args.grantee + '」不在成员表里。\n'
            + '已在册的成员：' + rosterLine(runtime.repo.users().map((user) => user.name)) + '\n'
            + '先用 family_member_add 把他加上。',
        }
      }
      if (grantee.status !== 'active') {
        return { ok: false, code: 'DISABLED_MEMBER', text: '「' + grantee.name + '」已被停用，不能授权。' }
      }

      const scope = { kind: scopeKind }
      if (scopeKind === 'owner') {
        const ids = []
        for (const name of args.owners || []) {
          const user = runtime.repo.findUserByName(name)
          if (!user) {
            return { ok: false, code: 'UNKNOWN_MEMBER', text: '「' + name + '」不在成员表里。' }
          }
          ids.push(user.id)
        }
        if (ids.length === 0) ids.push(actor.id)
        scope.ownerIds = ids
      }
      if (scopeKind === 'records') {
        scope.recordIds = Array.isArray(args.records) ? [...args.records] : []
      }

      let expiresAt = null
      if (typeof args.expires_at === 'string' && args.expires_at.length > 0) {
        const parsed = Date.parse(args.expires_at)
        if (!Number.isFinite(parsed)) {
          return { ok: false, code: 'BAD_DATE', text: '到期时间看不懂：' + args.expires_at + '（用 2026-12-31 这种格式）' }
        }
        expiresAt = new Date(parsed).toISOString()
      }

      const grant = runtime.repo.addGrant(
        { granteeId: grantee.id, module, permission, scope },
        { grantedBy: actor.id, expiresAt, note: args.note || '' },
      )
      runtime.auth.record(exec, module, 'grant', { allow: true, reason: 'administered-by-owner' })

      return {
        ok: true,
        grant: { id: grant.id, grantee: grantee.name, module, permission, scope },
        text: '已授权给「' + grantee.name + '」：' + describeGrant(grant) + '。\n'
          + '授权编号 ' + grant.id + '，随时可以用 family_revoke 收回。',
      }
    }),
  })
}

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_revoke` tool definition.
 */
export function createRevokeTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_revoke',
    description: 'Withdraw a grant by its id. The owner, or whoever issued the grant, may withdraw it.',
    parameters: {
      grant_id: { type: 'string', required: true, description: 'family_grants 里看到的授权编号。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      const actor = runtime.auth.requireActor(exec)
      const grant = runtime.repo.grants().find((item) => item.id === args.grant_id)
      if (!grant) {
        return { ok: false, code: 'NO_SUCH_GRANT', text: '找不到编号为 ' + args.grant_id + ' 的授权。' }
      }
      if (grant.revokedAt) {
        return { ok: true, already: true, text: '这条授权之前已经收回过了。' }
      }
      if (actor.role !== 'owner' && grant.grantedBy !== actor.id) {
        runtime.auth.record(exec, grant.module, 'revoke', { allow: false, reason: 'not-owner-or-grantor' })
        return denyText('只有户主或当初授权的人能收回这条授权。')
      }
      runtime.repo.revokeGrant(grant.id, actor.id)
      runtime.auth.record(exec, grant.module, 'revoke', { allow: true, reason: 'owner-or-grantor' })
      return { ok: true, revoked: grant.id, text: '已收回授权 ' + grant.id + '。' }
    }),
  })
}

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_grants` tool definition.
 */
export function createGrantsTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_grants',
    description: 'List grants: what this member holds, and (for the owner) what everyone holds.',
    parameters: {
      include_revoked: { type: 'boolean', description: '连已收回的一起列出。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      const actor = runtime.auth.requireActor(exec)
      const all = runtime.repo.grants()
      const visible = all.filter((grant) => {
        if (args.include_revoked ? false : grant.revokedAt) return false
        if (actor.role === 'owner') return true
        return grant.granteeId === actor.id || grant.grantedBy === actor.id
      })

      if (visible.length === 0) {
        return { ok: true, grants: [], text: '目前没有任何授权。' }
      }
      const byId = new Map(runtime.repo.users().map((user) => [user.id, user.name]))
      const lines = ['授权情况：']
      for (const grant of visible) {
        const grantee = byId.get(grant.granteeId) || grant.granteeId
        const state = grant.revokedAt ? '（已收回）' : ''
        lines.push('  · ' + grant.id + ' → ' + grantee + '：' + describeGrant(grant) + state)
      }
      return {
        ok: true,
        grants: visible.map((grant) => ({
          id: grant.id,
          grantee: byId.get(grant.granteeId) || grant.granteeId,
          module: grant.module,
          permission: grant.permission,
          revoked: Boolean(grant.revokedAt),
        })),
        text: lines.join('\n'),
      }
    }),
  })
}
