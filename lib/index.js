/**
 * dsh-family-auth — who a conversation belongs to, and what they may read.
 *
 * Phase 1 scaffold: the plugin loads, declares its name and service needs, and
 * owns no behaviour yet. Storage, identity and policy arrive in later commits.
 * @module dsh-family-auth
 */

export const name = 'dsh-family-auth'

/** Services this plugin collaborates with; all are optional peers. */
export const inject = ['tools']

/**
 * Deployment-owned configuration.
 */
export const Config = {}

export function apply(ctx, rawConfig = {}) {
  void ctx
  void rawConfig
}
