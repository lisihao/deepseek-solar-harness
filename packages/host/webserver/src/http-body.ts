import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib'

/** HTTP content encodings emitted by {@link HttpBodyVariants}. */
export type HttpContentEncoding = 'br' | 'gzip'

/** One selected wire representation of an HTTP body. */
export interface EncodedHttpBody {
  body: Buffer
  encoding?: HttpContentEncoding
}

/**
 * Lazily compressed, memoized representations of one immutable response body.
 * The caller still owns status, content type, cache policy, and response end.
 */
export interface HttpBodyVariants {
  /** Select the best supported representation for an Accept-Encoding header. */
  select(acceptEncoding: string | undefined): Promise<EncodedHttpBody>
}

const DEFAULT_COMPRESSION_THRESHOLD = 1_024

/** Return the declared quality for one encoding, preferring its exact token over `*`. */
function acceptedQuality(header: string, encoding: HttpContentEncoding): number {
  let wildcard: number | undefined
  for (const part of header.split(',')) {
    const [rawName, ...parameters] = part.trim().split(';')
    const name = rawName?.trim().toLowerCase()
    if (name !== encoding && name !== '*') continue
    let quality = 1
    for (const parameter of parameters) {
      const [key, rawValue] = parameter.trim().split('=')
      if (key?.toLowerCase() !== 'q') continue
      const parsed = Number(rawValue)
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
    }
    if (name === encoding) return quality
    wildcard = quality
  }
  return wildcard ?? 0
}

function compressBody(body: Buffer, encoding: HttpContentEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: Buffer): void => {
      if (error !== null) reject(error)
      else resolve(result)
    }
    if (encoding === 'br') {
      brotliCompress(body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      }, callback)
      return
    }
    gzip(body, { level: 6 }, callback)
  })
}

/**
 * Create one body representation set. Compression is lazy and each emitted
 * encoding is computed once, so versioned assets pay CPU only on first use.
 * Bodies below `minimumBytes` remain uncompressed.
 * @param input - immutable source bytes shared by every representation.
 * @param minimumBytes - inclusive size threshold for compression.
 * @returns a selector that memoizes each negotiated compressed body.
 */
export function createHttpBodyVariants(
  input: string | Uint8Array,
  minimumBytes = DEFAULT_COMPRESSION_THRESHOLD,
): HttpBodyVariants {
  const body = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const compressed = new Map<HttpContentEncoding, Promise<Buffer>>()
  return {
    async select(acceptEncoding) {
      if (body.length < minimumBytes || acceptEncoding === undefined) return { body }
      const brQuality = acceptedQuality(acceptEncoding, 'br')
      const gzipQuality = acceptedQuality(acceptEncoding, 'gzip')
      const encoding = brQuality > 0 && brQuality >= gzipQuality
        ? 'br'
        : gzipQuality > 0
          ? 'gzip'
          : undefined
      if (encoding === undefined) return { body }
      let pending = compressed.get(encoding)
      if (pending === undefined) {
        pending = compressBody(body, encoding)
        compressed.set(encoding, pending)
      }
      return { body: await pending, encoding }
    },
  }
}

/**
 * Headers that vary an encoded body safely and make its byte length explicit.
 * @param selected - body representation selected for the request.
 * @returns content length, vary, and optional content encoding headers.
 */
export function encodedHttpBodyHeaders(selected: EncodedHttpBody): Record<string, string> {
  return {
    'content-length': String(selected.body.length),
    vary: 'accept-encoding',
    ...(selected.encoding === undefined ? {} : { 'content-encoding': selected.encoding }),
  }
}
