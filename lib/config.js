/**
 * Config normalization. Config is deployment-owned: it comes from the profile's
 * cordis.patch.yml and never from a conversation, so the model cannot widen it.
 * @module dsh-family-auth/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandHome } from './util.js'

/**
 * Where authorization state lives unless the deployment says otherwise: inside
 * the harness home, so each DSH profile has its own member table.
 *
 * One fixed path would be a subtle disaster — profile A would authorize a
 * member, profile B would read that table and trust it, and neither the user
 * nor the model could see it happen.
 * @param {object} [env] - environment to read.
 * @returns {string} absolute directory.
 */
export function defaultDataDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'family-auth')
}

/** How the default reads in config descriptions. */
export const DEFAULT_DATA_DIR_LABEL = '<DSH_HOME>/family-auth（DSH_HOME 未设置时是 ~/.dsh/family-auth）'

/**
 * Owner id used for records written before anyone was identified, and readable
 * by every bound member. Deliberately not a real member id (those are `u_*`),
 * so it can never collide with a person.
 */
export const DEFAULT_OWNER = 'default'

/**
 * Everything the rest of the plugin reads. Never mutate; rebuild on config
 * change (Cordis calls apply again).
 * @param {object} [raw] - deployment config.
 * @returns {object} normalized config.
 */
export function normalizeConfig(raw = {}) {
  const configuredDir = typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
  const bootstrapOwner = typeof raw.bootstrap?.ownerName === 'string'
    ? raw.bootstrap.ownerName.trim()
    : ''

  return {
    enabled: raw.enabled !== false,
    dataDir: expandHome(configuredDir.length > 0 ? configuredDir : defaultDataDir()),
    /** Whoever first claims this name is created as the household owner. */
    bootstrapOwnerName: bootstrapOwner,
    /**
     * Where a write lands when nobody is identified. An empty string restores
     * the strict behaviour (refuse instead of recording under a shared name).
     */
    fallbackOwner: typeof raw.fallbackOwner === 'string' ? raw.fallbackOwner.trim() : DEFAULT_OWNER,
    /**
     * When true (the default) a conversation without a binding may not touch
     * personal data at all. Turning it off would be a deliberate downgrade.
     */
    requireBinding: raw.requireBinding !== false,
    /** Record every allow/deny decision; this is the only proof of no leak. */
    audit: raw.audit !== false,
    /** Register the behavioural contract skill for the model. */
    skill: raw.skill !== false,
    /** Inject the one-paragraph reminder into every system prompt. */
    brief: raw.brief !== false,
  }
}
