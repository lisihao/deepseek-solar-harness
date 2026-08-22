/** Profile-relative package resolution for Electron's restricted Node runtime. */

import { registerHooks } from 'node:module'
import { SEALED_RUNTIME_PACKAGES } from './product-bundles.ts'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
const DESKTOP_ENTRY_URL = new URL('../lib/index.js', import.meta.url).href
const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'
const PRODUCT_ENTRY_URLS = new Map<string, string>(
  SEALED_RUNTIME_PACKAGES.map(packageName => [packageName, import.meta.resolve(packageName)]),
)

/** Resolve one Desktop-owned Loader package to the App-sealed implementation. */
export function desktopProductEntryUrl(specifier: string): string | undefined {
  if (specifier === DESKTOP_PACKAGE_NAME) return DESKTOP_ENTRY_URL
  return PRODUCT_ENTRY_URLS.get(specifier)
}

/** Return whether a Loader request needs Node package resolution. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

/**
 * Resolve Cordis Loader bare imports from the selected persistent profile.
 * @param profileBaseUrl - file URL inside the profile that owns plugin dependencies.
 * @returns an idempotent hook disposer.
 */
export function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromLoader = context.parentURL === LOADER_ENTRY_URL
      // Product packages are immutable application inputs. Pin an exact
      // product-package request regardless of which Loader helper issued it;
      // Node's parent URL is not guaranteed to be the Loader entrypoint after
      // an include/aggregate plugin delegates the import.
      const productEntry = desktopProductEntryUrl(specifier)
      if (productEntry !== undefined) {
        return { shortCircuit: true, url: productEntry }
      }
      if (!fromLoader || !isBareSpecifier(specifier)) {
        return nextResolve(specifier, context)
      }
      return nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
    },
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
  }
}
