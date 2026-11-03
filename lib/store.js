/**
 * Append-only NDJSON storage.
 *
 * Every table is one file of JSON lines. Nothing is ever rewritten in place, so
 * a crash mid-write loses at most the last line, and `git diff` shows history.
 * Reads fold the log; writes only append.
 * @module dsh-family-auth/store
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * Create a store rooted at `dataDir`, creating the directory if needed.
 * @param {string} dataDir - absolute directory for the table files.
 * @returns {{dir: string, append: Function, read: Function, path: Function}} store handle.
 */
export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: DIR_MODE })

  /** @param {string} table - table name without extension. */
  function path(table) {
    return join(dataDir, table + '.ndjson')
  }

  return {
    dir: dataDir,
    path,
    /**
     * Append one record. A trailing newline keeps every line self-contained.
     * @param {string} table - table name.
     * @param {object} record - JSON-serializable record.
     * @returns {object} the record that was written.
     */
    append(table, record) {
      appendFileSync(path(table), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: FILE_MODE })
      return record
    },
    /**
     * Read every record. Unparsable lines are skipped rather than thrown: a
     * half-written tail must not make the household data unreadable.
     * @param {string} table - table name.
     * @returns {object[]} records in file order.
     */
    read(table) {
      const file = path(table)
      if (!existsSync(file)) return []
      const text = readFileSync(file, 'utf8')
      const out = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const value = JSON.parse(trimmed)
          if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value)
        } catch {
          // A truncated or hand-edited line is ignored, never fatal.
        }
      }
      return out
    },
  }
}
