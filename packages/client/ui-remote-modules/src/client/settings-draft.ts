/** Browser-side draft validation for the Remote Modules settings editor. */
import type { RemoteModulesConfig, WebpageInstanceConfig } from '../contract.ts'

/** Editable fields belonging to one remote Web page instance. */
export type RemoteModuleDraftField = 'id' | 'label' | 'url' | 'relayPort' | 'order'

/** One editor row; numeric values remain text until Save validates them. */
export interface RemoteModuleDraft {
  key: string
  id: string
  label: string
  url: string
  relayPort: string
  order: string
}

/** Stable error codes localized by the settings surface. */
export type RemoteModuleDraftError =
  | 'required' | 'invalidId' | 'duplicateId' | 'invalidUrl'
  | 'invalidPort' | 'duplicatePort' | 'invalidOrder'

/** Validation result carrying either a complete Host configuration or field errors. */
export interface RemoteModuleDraftValidation {
  config?: RemoteModulesConfig
  errors: Record<string, Partial<Record<RemoteModuleDraftField, RemoteModuleDraftError>>>
}

/**
 * Convert an accepted settings value into editable text rows.
 * @param instances - Validated plugin instances from the settings service.
 * @param key - Factory that supplies one stable React key per draft row.
 * @returns Text-valued rows suitable for editing without numeric coercion.
 */
export function draftRemoteModules(
  instances: readonly WebpageInstanceConfig[],
  key: () => string,
): RemoteModuleDraft[] {
  return instances.map(instance => ({
    key: key(),
    id: instance.id,
    label: instance.label,
    url: instance.url,
    relayPort: String(instance.relayPort),
    order: String(instance.order),
  }))
}

function setError(
  errors: RemoteModuleDraftValidation['errors'],
  key: string,
  field: RemoteModuleDraftField,
  error: RemoteModuleDraftError,
): void {
  const row = errors[key] ?? {}
  row[field] = error
  errors[key] = row
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

/**
 * Validate every draft without silently coercing incomplete numeric input.
 * @param drafts - Current editor rows, including unsaved text values.
 * @returns A complete configuration when valid, plus field-addressed errors otherwise.
 */
export function validateRemoteModuleDrafts(drafts: readonly RemoteModuleDraft[]): RemoteModuleDraftValidation {
  const errors: RemoteModuleDraftValidation['errors'] = {}
  const ids = new Map<string, string>()
  const ports = new Map<number, string>()
  const instances: WebpageInstanceConfig[] = []
  for (const draft of drafts) {
    const id = draft.id.trim()
    const label = draft.label.trim()
    const url = draft.url.trim()
    const relayPort = /^\d+$/.test(draft.relayPort.trim()) ? Number(draft.relayPort.trim()) : Number.NaN
    const order = /^-?\d+$/.test(draft.order.trim()) ? Number(draft.order.trim()) : Number.NaN
    if (id === '') setError(errors, draft.key, 'id', 'required')
    else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) setError(errors, draft.key, 'id', 'invalidId')
    const firstId = ids.get(id)
    if (id !== '' && firstId !== undefined) {
      setError(errors, firstId, 'id', 'duplicateId')
      setError(errors, draft.key, 'id', 'duplicateId')
    } else if (id !== '') ids.set(id, draft.key)
    if (label === '') setError(errors, draft.key, 'label', 'required')
    if (!validUrl(url)) setError(errors, draft.key, 'url', 'invalidUrl')
    if (!Number.isSafeInteger(relayPort) || relayPort < 0 || relayPort > 65535) {
      setError(errors, draft.key, 'relayPort', 'invalidPort')
    } else if (relayPort !== 0) {
      const firstPort = ports.get(relayPort)
      if (firstPort !== undefined) {
        setError(errors, firstPort, 'relayPort', 'duplicatePort')
        setError(errors, draft.key, 'relayPort', 'duplicatePort')
      } else ports.set(relayPort, draft.key)
    }
    if (!Number.isSafeInteger(order)) setError(errors, draft.key, 'order', 'invalidOrder')
    instances.push({ id, label, url, relayPort, order })
  }
  return Object.keys(errors).length === 0 && drafts.length > 0
    ? { config: { instances }, errors }
    : { errors }
}
