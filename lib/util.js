/**
 * Dependency-free helpers shared by the pure modules.
 * @module dsh-family-auth/util
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve a leading `~` without pulling in a config loader. Anything that is
 * not a string is returned untouched so callers can decide the fallback.
 * @param {unknown} path - candidate path.
 * @returns {unknown} expanded path, or the original value.
 */
export function expandHome(path) {
  if (typeof path !== 'string') return path
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Current instant as an ISO-8601 string; every stored record carries one.
 * @param {Date} [date] - instant to format.
 * @returns {string} ISO timestamp.
 */
export function nowIso(date = new Date()) {
  return date.toISOString()
}

/**
 * Clamp an integer into a range, falling back when the value is unusable.
 * @param {unknown} value - raw input.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - returned when `value` is not a finite number.
 * @returns {number} clamped integer.
 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Sortable-enough identifier: a prefix plus a base36 timestamp and entropy.
 * Records are append-only, so ordering comes from the file, not the id.
 * @param {string} prefix - short namespace such as `u` or `g`.
 * @returns {string} new identifier.
 */
export function newId(prefix) {
  const stamp = Date.now().toString(36)
  const entropy = Math.random().toString(36).slice(2, 8)
  return prefix + '_' + stamp + entropy
}

/**
 * Normalise a member name for comparison: trim, collapse inner whitespace.
 * Names are the one human-facing key, so they must compare predictably.
 * @param {unknown} name - raw name.
 * @returns {string} comparable name, empty when unusable.
 */
export function normalizeName(name) {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ')
}
