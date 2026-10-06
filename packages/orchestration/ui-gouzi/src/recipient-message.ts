/** Shared durable envelope for explicitly addressed kennel messages. */
/** Confirmed execution identity, independent of the display name. */
export interface KennelRecipient { readonly gouziId: string; readonly generation: number; readonly mode: 'standard' }
const PREFIX = '[DSH kennel recipient]\n'
const PLAIN_PREFIX = '[DSH kennel plain]\n'
function valid(v: unknown): v is KennelRecipient {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.gouziId === 'string' && r.gouziId.length > 0 && r.gouziId.trim() === r.gouziId && typeof r.generation === 'number' && Number.isSafeInteger(r.generation) && r.generation > 0 && r.mode === 'standard'
}
/**
 * Encode a confirmed target, preserving the body verbatim. Manager messages starting
 * with a reserved marker receive a plain-text envelope so quoted markers never select a target.
 * @param text - original body.
 * @param recipient - target, or null for the manager.
 * @returns durable text.
 * @throws Error for invalid recipient fields.
 */
export function encodeKennelMessage(text: string, recipient: KennelRecipient | null): string {
  if (recipient === null) {
    return text.startsWith(PREFIX) || text.startsWith(PLAIN_PREFIX)
      ? PLAIN_PREFIX + JSON.stringify({ version: 1 }) + '\n' + text
      : text
  }
  if (!valid(recipient)) throw new Error('Invalid kennel recipient')
  return PREFIX + JSON.stringify({ version: 1, gouziId: recipient.gouziId, generation: recipient.generation, mode: recipient.mode }) + '\n' + text
}
/**
 * Decode one leading envelope, preserving ordinary text and the body. A plain-text
 * envelope returns its complete body without interpreting any marker inside it.
 * @param text - durable text.
 * @returns body and optional target.
 * @throws Error for a malformed leading envelope or unsupported version/mode.
 */
export function decodeKennelMessage(text: string): { text: string; recipient?: KennelRecipient } {
  const plain = text.startsWith(PLAIN_PREFIX)
  const prefix = plain ? PLAIN_PREFIX : PREFIX
  if (!text.startsWith(prefix)) return { text }
  const failure = plain ? 'Invalid kennel plain envelope' : 'Invalid kennel recipient envelope'
  const end = text.indexOf('\n', prefix.length)
  if (end < 0) throw new Error(failure)
  let value: unknown
  try { value = JSON.parse(text.slice(prefix.length, end)) }
  catch { throw new Error(failure) }
  if (plain) {
    if (value === null || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || Object.keys(value).length !== 1) throw new Error(failure)
    return { text: text.slice(end + 1) }
  }
  if (!valid(value) || !('version' in value) || value.version !== 1) throw new Error(failure)
  return { text: text.slice(end + 1), recipient: { gouziId: value.gouziId, generation: value.generation, mode: value.mode } }
}
