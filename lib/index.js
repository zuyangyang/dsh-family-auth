/**
 * dsh-family-auth — who is speaking, and what may they see.
 *
 * Family members talk to the same assistant from different chats and different
 * accounts. This plugin binds each conversation to one member, keeps an
 * append-only grant ledger, and exposes three guards that other plugins call
 * before touching personal data.
 *
 * Design: DESIGN.md.
 * @module dsh-family-auth
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DEFAULT_DATA_DIR, normalizeConfig } from './config.js'
import { createStore } from './store.js'
import { createRepo } from './repo.js'
import { createAuthService } from './auth.js'
import { buildBrief, registerSkill } from './skill.js'
import { createBindTool, createWhoamiTool } from './tools/identity.js'
import { createMemberAddTool, createMemberListTool } from './tools/members.js'
import { createGrantTool, createGrantsTool, createRevokeTool } from './tools/grants.js'
import { createAuditTool } from './tools/audit.js'

export const name = 'dsh-family-auth'

export const inject = ['tools', 'skills', 'systemPrompt']

/**
 * Deployment-owned configuration. Every field is described because this block
 * is what a settings page and `--dump-config-schema` render.
 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('关掉后不注册任何工具，已有的成员和授权文件保持原样。'),
  dataDir: z.string().default(DEFAULT_DATA_DIR)
    .description('成员、绑定、授权、审计四张表所在目录。默认 ' + DEFAULT_DATA_DIR + '。'),
  bootstrap: z.object({
    ownerName: z.string().default(''),
  }).default({ ownerName: '' })
    .description('户主名字。设了之后，只有这个名字的首次认领会成为户主；留空则第一个认领的人成为户主。'),
  fallbackOwner: z.string().default('default')
    .description('认不出是谁时，写入记到这个"共享桶"名下，共享桶对所有已绑定成员可见。'
      + '设成空字符串则恢复严格模式：未绑定就拒绝写入。'),
  requireBinding: z.boolean().default(true)
    .description('要求对话先绑定成员才允许读个人数据。配了 fallbackOwner 时，未绑定只能看到共享桶。'),
  audit: z.boolean().default(true)
    .description('把每次允许/拒绝的鉴权决定写进 audit.ndjson。这是"没串数据"的唯一证据。'),
  skill: z.boolean().default(true)
    .description('注册行为契约 skill，教模型不要绕过权限说话。'),
  brief: z.boolean().default(true)
    .description('在每轮系统提示里加一段权限提醒。'),
})

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} [rawConfig] - deployment config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    warn({ logger: ctx.logger }, '[family-auth] disabled by config')
    return
  }

  const store = createStore(config.dataDir)
  const repo = createRepo(store)
  const auth = createAuthService({ repo, config })
  const runtime = { repo, store, config, auth, logger: ctx.logger }

  // Other plugins consume the guards through `ctx.familyAuth`; providing it here is
  // what makes this plugin generic rather than ledger-specific.
  guard(runtime, 'service familyAuth', () => ctx.provide('familyAuth', auth))

  const loaded = []
  for (const [label, factory] of [
    ['family_whoami', createWhoamiTool],
    ['family_bind', createBindTool],
    ['family_member_list', createMemberListTool],
    ['family_member_add', createMemberAddTool],
    ['family_grant', createGrantTool],
    ['family_revoke', createRevokeTool],
    ['family_grants', createGrantsTool],
    ['family_audit', createAuditTool],
  ]) {
    guard(runtime, 'tool ' + label, () => {
      ctx.tools.register(factory(runtime, defineTool))
      loaded.push(label)
    })
  }

  guard(runtime, 'skill', () => registerSkill(ctx, { config }))

  if (config.brief) {
    guard(runtime, 'brief', () => {
      ctx.systemPrompt.context({
        name: 'dsh-family-auth:brief',
        order: 35,
        text: () => buildBrief(),
      })
    })
  }

  const members = repo.users().length
  const grantCount = repo.liveGrants().length
  info(runtime, '[family-auth] ready at ' + config.dataDir + ' (' + members + ' 成员, '
    + grantCount + ' 条授权, ' + loaded.length + ' 工具)')
}

/**
 * Run one registration step, reporting instead of throwing.
 *
 * A broken tool registration must not take the whole profile down: the rest of
 * the assistant keeps working and the failure is visible in the log.
 * @param {object} runtime - runtime handle.
 * @param {string} label - what is being registered.
 * @param {Function} step - registration to attempt.
 * @returns {void}
 */
function guard(runtime, label, step) {
  try {
    step()
  } catch (error) {
    runtime.failures = (runtime.failures || 0) + 1
    warn(runtime, '[family-auth] ' + label + ' failed: ' + (error?.message ?? error))
  }
}

function warn(runtime, message) {
  const logger = runtime?.logger
  if (logger && typeof logger.warn === 'function') logger.warn(message)
}

function info(runtime, message) {
  const logger = runtime?.logger
  if (logger && typeof logger.info === 'function') logger.info(message)
}
