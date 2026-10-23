import { fileURLToPath } from 'node:url'

/** Absolute directory of the bundled `dsh-native` suite data, beside both `src/` and the built `lib/`. */
export const DSH_NATIVE_SUITE_DIR = fileURLToPath(new URL('../suite/', import.meta.url))
