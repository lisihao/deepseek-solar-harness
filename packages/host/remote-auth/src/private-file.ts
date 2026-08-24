/** Owner-only local state file loading shared by remote-auth authorities. */

import { readFile, stat } from 'node:fs/promises'

/**
 * Read a local authority file, returning undefined only when it does not exist.
 * @param filename - Absolute or process-relative path to the authority file.
 * @returns The UTF-8 file contents, or undefined when the file is absent.
 */
export async function readOwnerOnlyText(filename: string): Promise<string | undefined> {
  try {
    const file = await stat(filename)
    if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) {
      throw new Error(`remote-auth: ${filename} must be owner-only (chmod 600)`)
    }
    return await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
