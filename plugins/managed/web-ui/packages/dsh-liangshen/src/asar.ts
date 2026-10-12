import { existsSync } from 'node:fs'

/**
 * Map a path inside an Electron `app.asar` archive to its `app.asar.unpacked` twin when that exists.
 * `cpSync` and `readdirSync` cannot copy a tree out of the archive, and the files a package lists in
 * `asarUnpack` live only in the unpacked directory, so a sync that reads the archive path fails with ENOENT.
 * @param path - absolute path that may point into an `app.asar` archive.
 * @param exists - file existence probe (test seam).
 * @returns the unpacked path when the archive path has one on disk, otherwise `path` unchanged.
 */
export function unpackedAsarPath(path: string, exists: (candidate: string) => boolean = existsSync): string {
  const unpacked = path.replace(/\.asar([\\/])/u, '.asar.unpacked$1')
  return unpacked !== path && exists(unpacked) ? unpacked : path
}
