/** Complete local research bytes and ordered text transfer; neither grants access nor proves website submission. */
import { createHash } from 'node:crypto'
import type {
  ResearchArtifactSnapshot, ResearchCaptureSource, ResearchTextChunk, ResearchTextHandoff,
} from '@deepseek-ai/dsh-research-handoff/api'

/** Invalid text, capture metadata, chunk sequence, byte range, or integrity evidence. */
export class ResearchArtifactError extends Error {
  constructor(message: string) { super(message); this.name = 'ResearchArtifactError' }
}

/**
 * Hash exact bytes without asserting their truth, completeness, or read authorization.
 * @param bytes - Retained bytes.
 * @returns Lowercase SHA-256 digest.
 */
export function researchArtifactHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Decode exact UTF-8 without replacement or normalization, including a leading byte order mark.
 * @param bytes - Bytes to validate.
 * @returns Exact decoded text; invalid UTF-8 throws.
 */
export function researchArtifactText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/**
 * Validate durable or imported capture provenance without treating it as execution authority.
 * @param value - Untrusted JSON metadata.
 * @returns Valid capture fields; complete capture requires explicit report-end evidence.
 */
export function parseResearchCapture(value: unknown): ResearchCaptureSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchArtifactError('invalid capture metadata')
  const record = value as Record<string, unknown>
  if (typeof record.page !== 'string' || !record.page || typeof record.capturedAt !== 'string' || !record.capturedAt
    || record.conversation !== null && typeof record.conversation !== 'string'
    || typeof record.method !== 'string' || !['dom-text', 'download', 'manual-import'].includes(record.method)
    || typeof record.extent !== 'string' || !['complete', 'partial', 'unknown'].includes(record.extent)
    || record.endEvidence !== null && typeof record.endEvidence !== 'string'
    || record.extent === 'complete' && (typeof record.endEvidence !== 'string' || !record.endEvidence.trim())) {
    throw new ResearchArtifactError('invalid capture provenance or missing report-end evidence')
  }
  return record as unknown as ResearchCaptureSource
}

/**
 * Split all retained bytes without cutting a UTF-8 code point or silently truncating.
 * @param artifact - Owner-authorized artifact read.
 * @param maxChunkBytes - Explicit transport segment budget, at least four bytes.
 * @returns Full ordered local handoff; this is not proof of actual website input.
 */
export function splitResearchArtifact(artifact: ResearchArtifactSnapshot, maxChunkBytes: number): ResearchTextHandoff {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 4) throw new ResearchArtifactError('chunk budget must be at least four bytes')
  researchArtifactText(artifact.bytes)
  if (researchArtifactHash(artifact.bytes) !== artifact.sha256) throw new ResearchArtifactError('artifact bytes do not match their digest')
  const view = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset, artifact.bytes.byteLength)
  const chunks: ResearchTextChunk[] = []
  let start = 0
  do {
    let end = Math.min(start + maxChunkBytes, artifact.bytes.length)
    while (end < artifact.bytes.length && (view.getUint8(end) & 0xc0) === 0x80) end--
    const bytes = artifact.bytes.subarray(start, end)
    chunks.push({
      index: chunks.length, byteStart: start, byteEnd: end,
      sha256: researchArtifactHash(bytes), text: researchArtifactText(bytes),
    })
    start = end
  } while (start < artifact.bytes.length)
  return {
    format: 'research-text-handoff/v1', artifactId: artifact.artifactId, artifactVersion: artifact.version,
    sha256: artifact.sha256, totalBytes: artifact.bytes.length, chunkCount: chunks.length, chunks,
  }
}

/**
 * Validate and reassemble an imported handoff, rejecting missing, reordered, duplicate, or changed segments.
 * @param value - Untrusted file or transport JSON.
 * @returns Exact validated bytes; no read permission or website-submission claim is derived.
 */
export function restoreResearchHandoff(value: unknown): Uint8Array {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchArtifactError('invalid handoff')
  const record = value as Record<string, unknown>
  if (record.format !== 'research-text-handoff/v1' || typeof record.artifactId !== 'string' || !record.artifactId
    || !Number.isSafeInteger(record.artifactVersion) || (record.artifactVersion as number) < 1
    || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.totalBytes) || (record.totalBytes as number) < 0
    || !Array.isArray(record.chunks) || record.chunks.length < 1 || record.chunkCount !== record.chunks.length) {
    throw new ResearchArtifactError('invalid handoff manifest or missing chunks')
  }
  const parts: Uint8Array[] = []
  let offset = 0
  for (const [index, value] of record.chunks.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchArtifactError('invalid handoff chunk')
    const chunk = value as Record<string, unknown>
    if (chunk.index !== index || chunk.byteStart !== offset || typeof chunk.text !== 'string') {
      throw new ResearchArtifactError('handoff chunks are missing, duplicated, or reordered')
    }
    const bytes = new TextEncoder().encode(chunk.text)
    if (researchArtifactText(bytes) !== chunk.text || chunk.byteEnd !== offset + bytes.length
      || chunk.sha256 !== researchArtifactHash(bytes)) throw new ResearchArtifactError('handoff chunk bytes changed')
    parts.push(bytes)
    offset += bytes.length
    if (offset > (record.totalBytes as number)) throw new ResearchArtifactError('handoff byte count exceeded')
  }
  if (offset !== record.totalBytes) throw new ResearchArtifactError('handoff byte count does not match')
  const result = new Uint8Array(offset)
  let at = 0
  for (const bytes of parts) { result.set(bytes, at); at += bytes.length }
  if (researchArtifactHash(result) !== record.sha256) throw new ResearchArtifactError('full handoff digest changed')
  return result
}
