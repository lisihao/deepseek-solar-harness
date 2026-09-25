export const REQUIRED_CONFIG_MARKERS = Object.freeze([
  "name: '@deepseek-ai/dsh-invariants'",
  "name: '@lisihao/dsh-code-harness-governance'",
  "name: '@lisihao/dsh-code-harness-governance/invariant'",
  'strict: true',
])

const REQUIRED_ROWS = Object.freeze([
  {
    id: 'code-harness-invariants',
    name: '@deepseek-ai/dsh-invariants',
    required: ['enabled: true'],
  },
  {
    id: 'code-harness-governance',
    name: '@lisihao/dsh-code-harness-governance',
    required: ['strict: true'],
  },
  {
    id: 'code-harness-governance-invariant',
    name: '@lisihao/dsh-code-harness-governance/invariant',
    required: [],
  },
])

export function dshCommand(environment = process.env) {
  if (environment.DSH_COMMAND_JSON === undefined) return [environment.DSH_BIN || 'dsh']
  let parsed
  try {
    parsed = JSON.parse(environment.DSH_COMMAND_JSON)
  } catch (error) {
    throw new Error(`DSH_COMMAND_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(value => typeof value !== 'string' || value === '')) {
    throw new Error('DSH_COMMAND_JSON must be a non-empty JSON array of non-empty strings')
  }
  return parsed
}

export function verifyDumpConfig(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, missing: [...REQUIRED_CONFIG_MARKERS], message: 'empty composed configuration' }
  }
  const rows = new Map()
  for (const block of text.split(/\n(?=- id: )/gu)) {
    const id = /^- id: ([^\n]+)$/mu.exec(block)?.[1]?.trim()
    if (id !== undefined) rows.set(id, block)
  }
  const missing = []
  for (const requirement of REQUIRED_ROWS) {
    const row = rows.get(requirement.id)
    if (row === undefined) {
      missing.push(`id: ${requirement.id}`)
      continue
    }
    if (!row.includes(`name: '${requirement.name}'`)) missing.push(`${requirement.id} name`)
    if (/^\s*disabled:\s*true\s*$/mu.test(row)) missing.push(`${requirement.id} enabled`)
    for (const marker of requirement.required) {
      if (!row.includes(marker)) missing.push(`${requirement.id} ${marker}`)
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    message: missing.length === 0
      ? 'governance policy and invariant are present in the final composed configuration'
      : `missing required governance config marker(s): ${missing.join(', ')}`,
  }
}

export function withGovernedProfile(args) {
  const copy = [...args]
  const hasProfile = copy.some((value, index) => value === '--profile' && typeof copy[index + 1] === 'string')
  return hasProfile ? copy : ['--profile', 'governed-code', ...copy]
}
