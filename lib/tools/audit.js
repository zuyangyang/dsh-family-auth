/**
 * `family_audit`: what the authorization layer actually decided.
 *
 * This is the only evidence that a read did not cross members, so it is owner
 * only and never truncated silently.
 * @module dsh-family-auth/tools/audit
 */

import { denyText, guarded } from './shared.js'

const identityDefineTool = (definition) => definition

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_audit` tool definition.
 */
export function createAuditTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_audit',
    description: 'Show recent authorization decisions (allows and refusals). Owner only. '
      + 'Use it when someone asks "谁看过我的账" or when access looks wrong.',
    parameters: {
      limit: { type: 'number', description: '返回最近多少条，默认 20，最多 200。' },
      only_denied: { type: 'boolean', description: '只看被拒绝的。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      const actor = runtime.auth.requireActor(exec)
      if (actor.role !== 'owner') {
        runtime.auth.record(exec, 'auth', 'audit-read', { allow: false, reason: 'not-owner' })
        return denyText('审计记录只有户主能看。')
      }
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 20))
      let entries = runtime.repo.auditLog(0)
      if (args.only_denied) entries = entries.filter((entry) => !entry.allow)
      entries = entries.slice(-limit)

      if (entries.length === 0) {
        return { ok: true, entries: [], text: '没有符合条件的审计记录。' }
      }

      const byId = new Map(runtime.repo.users().map((user) => [user.id, user.name]))
      const lines = ['最近的鉴权记录（共 ' + entries.length + ' 条）：']
      for (const entry of entries) {
        const who = entry.sessionId ? '会话 ' + String(entry.sessionId).slice(-6) : '未知会话'
        const mark = entry.allow ? '允许' : '拒绝'
        const owner = entry.ownerId ? ' · 归属 ' + (byId.get(entry.ownerId) || entry.ownerId) : ''
        lines.push('  · ' + String(entry.at).slice(0, 19) + ' ' + mark + ' ' + (entry.module || '-') + '/' + entry.action + owner + ' · ' + who)
      }
      return { ok: true, entries, text: lines.join('\n') }
    }),
  })
}
