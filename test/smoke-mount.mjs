/**
 * Mount smoke test: boot the plugin against a mock Cordis context.
 *
 * The unit tests cover the rules; this covers the wiring -- that the real
 * defineTool from @deepseek-ai/dsh-tools accepts our definitions, and that the
 * service, tools, skill and prompt all register. Not part of "npm test"
 * because it needs the DSH packages installed.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../lib/index.js'

const tools = []
const skills = []
const prompts = []
const provided = {}

const ctx = {
  logger: { info(m) { console.log('INFO ' + m) }, warn(m) { console.log('WARN ' + m) } },
  tools: { register(tool) { tools.push(tool) } },
  skills: { register(skill) { skills.push(skill) } },
  systemPrompt: { context(entry) { prompts.push(entry) } },
  provide(key, value) { provided[key] = value },
}

const dataDir = mkdtempSync(join(tmpdir(), 'family-auth-smoke-'))
apply(ctx, { dataDir, bootstrap: { ownerName: '杨' } })

const failures = []
const check = (label, ok) => { if (!ok) failures.push(label) }

const expected = ['family_audit', 'family_bind', 'family_grant', 'family_grants',
  'family_member_add', 'family_member_list', 'family_revoke', 'family_whoami']

check('plugin name', name === 'dsh-family-auth')
check('service provided', Boolean(provided.familyAuth) && typeof provided.familyAuth.mustWrite === 'function')
check('eight tools', tools.length === 8)
check('tool names', tools.map((t) => t.name).sort().join(',') === expected.join(','))
check('every tool executes', tools.every((t) => typeof t.execute === 'function'))
check('every tool renders', tools.every((t) => t.output && typeof t.output.render === 'function'))
check('skill registered', skills.length === 1 && skills[0].name === 'family-auth')
check('brief registered', prompts.length === 1 && prompts[0].name === 'dsh-family-auth:brief')

console.log('dataDir: ' + dataDir)
console.log('tools: ' + tools.map((t) => t.name).join(', '))
console.log('skill: ' + skills.map((s) => s.name).join(', '))
console.log('prompt: ' + prompts.map((p) => p.name + ' @' + p.order).join(', '))

if (failures.length > 0) {
  console.error('SMOKE FAILED: ' + failures.join('; '))
  process.exit(1)
}
console.log('SMOKE OK')
