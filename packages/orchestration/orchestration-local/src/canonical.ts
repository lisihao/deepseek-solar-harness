/** Deterministic JSON encoding and SHA-256 helpers for durable orchestration artifacts. */
import { createHash } from 'node:crypto'

/**
 * Recursively order object keys while preserving array order.
 * @param value - JSON-compatible input to normalize.
 * @returns a recursively normalized JSON-compatible value.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => [key, canonicalize(record[key])]),
    )
  }
  return value
}

/**
 * Encode one JSON value deterministically.
 * @param value - JSON-compatible input to encode.
 * @returns canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Return the lowercase SHA-256 digest of one deterministic JSON value.
 * @param value - JSON-compatible input to hash.
 * @returns lowercase hexadecimal SHA-256 digest.
 */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
