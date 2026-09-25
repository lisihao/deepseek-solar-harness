/** Baseline Intent, Context, and local Capability Capsule Providers. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import CapabilityCapsuleService, {
  CapabilityCapsuleError,
  CapabilityCapsuleRef,
  type CapabilityBindingPlanV1,
  type CapabilityCapsuleManifestV1,
  type CapabilityEffectSet,
  type CapsuleCatalogSnapshot,
  type CapsuleResolutionRequest,
  type CapsuleSnapshotRequest,
} from '@deepseek-ai/dsh-capability-capsule'
import ContextCompilerService, {
  ContextCompilerError,
  type ContextCompileRequest,
  type ContextPacketV1,
  type ContextSourceRef,
} from '@deepseek-ai/dsh-context-compiler'
import IntentCompilerService, {
  IntentCompilerError,
  type IntentCompileRequest,
  type IntentIRV1,
} from '@deepseek-ai/dsh-intent-compiler'
import { canonicalSha256 } from './canonical.ts'
import { BROWSER_CAPABILITY } from './browser-model-tool-bridge.ts'

const EMPTY_EFFECTS: CapabilityEffectSet = Object.freeze({
  read: [], write: [], execute: [], network: [], cost: [], risk: [],
})

/** Mandatory instruction capability that isolates every durable TaskGraph node from resident history. */
export const CLEAN_TASK_CONTEXT_CAPABILITY = 'context.clean-task'

function cleanTaskContextCapsule(): CapabilityCapsuleManifestV1 {
  const manifest: CapabilityCapsuleManifestV1 = {
    version: 1,
    id: 'dsh.clean-task-context',
    capsuleVersion: '1.0.0',
    kind: 'instruction',
    digest: '',
    provenance: { publisher: 'DeepSeek-Solar-Harness', sourceRef: 'builtin:orchestration-local' },
    applicability: ['durable TaskGraph node execution through a resident physical operator'],
    capabilityTags: [CLEAN_TASK_CONTEXT_CAPABILITY],
    inputs: ['sealed ContextPacketV1'],
    outputs: ['task-scoped resident execution'],
    preconditions: ['A sealed TaskGraph node context is available.'],
    postconditions: ['Unrelated resident history is not propagated to the node or its children.'],
    invariants: ['Only the current Context Packet and its explicit upstream artifact references are authoritative.'],
    consumes: [], produces: [], requires: [], compatible: ['codex', 'claude-code'], incompatible: [],
    effects: EMPTY_EFFECTS,
    bindings: {
      instructions: [
        'Treat this node as a fresh task context. Do not rely on, quote, or propagate unrelated history from a reused Resident host. Use only this Context Packet and its explicit upstream artifact references. If you create child agents, give them empty or bounded task-specific context (fork_turns: "none" or an equivalent fresh-context mechanism); never clone the full Resident history with fork_turns: "all".',
      ],
      skills: [], toolsAllow: [], toolsDeny: [], mcpServers: [], resourceRefs: [], dataRefs: [],
      secretRefs: [], guardRefs: [],
    },
    verification: ['Context Packet contains the clean-context instruction before dispatch.'],
    operatorCompatibility: ['codex', 'claude-code'],
  }
  return { ...manifest, digest: canonicalSha256(manifest) }
}

/** Built-in model tool Capsule for Resident browser-capable nodes. */
function browserCapsule(): CapabilityCapsuleManifestV1 {
  const manifest: CapabilityCapsuleManifestV1 = {
    version: 1,
    id: 'dsh.browser-automation',
    capsuleVersion: '1.0.0',
    kind: 'tool',
    digest: '',
    provenance: { publisher: 'DeepSeek-Solar-Harness', sourceRef: 'builtin:orchestration-local' },
    applicability: ['durable TaskGraph nodes that explicitly require browser capability'],
    capabilityTags: [BROWSER_CAPABILITY],
    inputs: ['sealed browser plan'],
    outputs: ['bounded BrowserRunResultV1'],
    preconditions: ['A configured provider-neutral ctx.browser service is available.'],
    postconditions: ['Browser operations complete in the submitted order.'],
    invariants: ['Only the model-facing closed browser plan is exposed; provider-native control is not exposed.'],
    consumes: [], produces: [], requires: [], compatible: ['codex', 'claude-code'], incompatible: [],
    // Network authority remains an explicit graph concern. The browser seam
    // itself does not invent a scope/effect budget for the caller.
    effects: EMPTY_EFFECTS,
    bindings: {
      instructions: [
        'Use the sealed browser tool for webpage interaction. Submit typed portable plans, prefer semantic locators, and verify resulting state before reporting success.',
      ],
      skills: [], toolsAllow: ['browser'], toolsDeny: [], mcpServers: [], resourceRefs: [], dataRefs: [],
      secretRefs: [], guardRefs: [],
    },
    verification: ['Resident dispatch supplies a browser model-tool bridge and dsh-tools-authoritative native policy.'],
    operatorCompatibility: ['codex', 'claude-code'],
  }
  return { ...manifest, digest: canonicalSha256(manifest) }
}

function cleaned(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort()
}

/** Deterministic pass-through Intent Provider. */
export class DirectIntentCompiler extends IntentCompilerService {
  /** Stable baseline compiler identity recorded in Intent provenance. */
  static readonly compilerId = 'direct-intent'
  /** Semantic version of deterministic direct-intent behavior. */
  static readonly compilerVersion = '1.0.0'

  compile(request: IntentCompileRequest): Promise<IntentIRV1> {
    const objective = request.request.trim()
    if (objective.length === 0) throw new IntentCompilerError('intent request must be non-blank', 'INTENT_INVALID')
    const sourceRefs = cleaned(request.sourceRefs)
    const attachmentRefs = cleaned(request.attachmentRefs)
    const ambiguities = /(?:\?\?\?|\bTBD\b|待明确|不确定需求)/iu.test(objective)
      ? ['request contains an explicit unresolved placeholder']
      : []
    const input = { request: objective, sourceRefs, attachmentRefs, compilerHint: request.compilerHint }
    const withoutOutput: Omit<IntentIRV1['provenance'], 'outputSha256'> & { readonly outputSha256?: string } = {
      compilerId: DirectIntentCompiler.compilerId,
      compilerVersion: DirectIntentCompiler.compilerVersion,
      inputSha256: canonicalSha256(input),
    }
    const base = {
      version: 1 as const,
      objective,
      expectedOutcomes: [objective],
      constraints: [],
      nonGoals: [],
      acceptanceRequirements: ['Every required TaskGraph node satisfies its declared acceptance checks.'],
      sourceRefs,
      attachmentRefs,
      riskHints: [],
      ambiguities,
      requiresClarification: ambiguities.length > 0,
      provenance: withoutOutput,
    }
    const outputSha256 = canonicalSha256(base)
    return Promise.resolve({ ...base, provenance: { ...withoutOutput, outputSha256 } })
  }
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*\S+/giu,
]

function redact(value: string): { text: string; changed: boolean } {
  let text = value
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]')
  return { text, changed: text !== value }
}

function unavailable(ref: ContextSourceRef): boolean {
  return ref.ref.startsWith('unavailable:')
}

/** Minimal deterministic Context Provider with lineage and redaction. */
export class BasicContextCompiler extends ContextCompilerService {
  /** Stable baseline compiler identity recorded in Context provenance. */
  static readonly compilerId = 'basic-context'
  /** Semantic version of deterministic basic-context behavior. */
  static readonly compilerVersion = '1.0.0'

  compile(request: ContextCompileRequest): Promise<ContextPacketV1> {
    if (!Number.isSafeInteger(request.policy.maxTokens) || request.policy.maxTokens < 1) {
      throw new ContextCompilerError('context token budget must be a positive integer', 'CONTEXT_INVALID')
    }
    const allowed = new Set(request.policy.allowedSourceKinds)
    const included: ContextSourceRef[] = []
    const dropped: { source: ContextSourceRef; reason: string }[] = []
    const degradedSources: string[] = []
    for (const source of request.sourceRefs) {
      if (!allowed.has(source.kind)) {
        dropped.push({ source, reason: 'source kind is outside the certified context policy' })
        continue
      }
      if (!unavailable(source)) {
        included.push(source)
        continue
      }
      if (source.required && request.policy.unavailableSource === 'block') {
        throw new ContextCompilerError(`required context source is unavailable: ${source.ref}`, 'CONTEXT_SOURCE_UNAVAILABLE')
      }
      degradedSources.push(source.ref)
      dropped.push({ source, reason: 'source unavailable' })
    }
    const task = redact(request.task)
    const includedRefs = new Set(included.map(source => source.ref))
    const sourceMaterials = (request.sourceMaterials ?? []).map((material) => {
      if (!includedRefs.has(material.ref)) {
        throw new ContextCompilerError(
          `materialized context source is not included by policy: ${material.ref}`,
          'CONTEXT_INVALID',
        )
      }
      const result = redact(material.text)
      return { ...material, text: result.text, changed: result.changed }
    })
    const instructions = request.capsuleInstructions.map((instruction) => {
      const result = redact(instruction.text)
      return { ...instruction, text: result.text, changed: result.changed }
    })
    const redactions = [
      ...task.changed ? ['task'] : [],
      ...instructions.filter(value => value.changed).map(value => `capsule:${value.ref}`),
      ...sourceMaterials.filter(value => value.changed).map(value => `source:${value.ref}`),
    ]
    const capsuleInstructions = instructions.map(({ changed: _changed, ...value }) => value)
    const materials = sourceMaterials.map(({ changed: _changed, ...value }) => value)
    const estimateInput = {
      objective: request.objective,
      workspace: request.workspace,
      task: task.text,
      included,
      sourceMaterials: materials,
      readScopes: request.readScopes,
      writeScopes: request.writeScopes,
      acceptance: request.acceptance,
      capsuleInstructions,
    }
    const estimatedTokens = Math.ceil(JSON.stringify(estimateInput).length / 4)
    if (estimatedTokens > request.policy.maxTokens) {
      throw new ContextCompilerError(
        `minimum context requires ${String(estimatedTokens)} tokens but budget is ${String(request.policy.maxTokens)}`,
        'CONTEXT_BUDGET_EXCEEDED',
      )
    }
    const base = {
      version: 1 as const,
      runId: request.runId,
      nodeId: request.nodeId,
      objective: request.objective,
      workspace: request.workspace,
      task: task.text,
      included,
      sourceMaterials: materials,
      summarized: [],
      dropped,
      estimatedTokens,
      tokenBudget: request.policy.maxTokens,
      lineage: included.map(source => source.ref),
      degradedSources,
      redactions,
      capsuleInstructions,
      compilerId: BasicContextCompiler.compilerId,
      compilerVersion: BasicContextCompiler.compilerVersion,
    }
    return Promise.resolve({ ...base, packetSha256: canonicalSha256(base) })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateManifest(value: unknown, source: string): CapabilityCapsuleManifestV1 {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || typeof value.capsuleVersion !== 'string' || typeof value.kind !== 'string'
    || !isRecord(value.provenance) || !isRecord(value.effects) || !isRecord(value.bindings)) {
    throw new CapabilityCapsuleError(`invalid capability capsule manifest: ${source}`, 'CAPSULE_INVALID')
  }
  const manifest = value as unknown as CapabilityCapsuleManifestV1
  const actualDigest = canonicalSha256({ ...manifest, digest: '' })
  if (manifest.digest !== actualDigest) {
    throw new CapabilityCapsuleError(`capability capsule digest mismatch: ${source}`, 'CAPSULE_INVALID')
  }
  return manifest
}

function effectValues(effects: CapabilityEffectSet): readonly [keyof CapabilityEffectSet, readonly string[]][] {
  return [
    ['read', effects.read], ['write', effects.write], ['execute', effects.execute],
    ['network', effects.network], ['cost', effects.cost], ['risk', effects.risk],
  ]
}

function within(value: string, budget: readonly string[]): boolean {
  return budget.includes('*') || budget.includes(value) || budget.some(scope => value.startsWith(`${scope}/`))
}

function union(values: readonly (readonly string[])[]): string[] {
  return [...new Set(values.flat())].sort()
}

/** Owner-local content-addressed Capsule Registry and monotonic resolver. */
export class LocalCapabilityCapsuleService extends CapabilityCapsuleService {
  private revision = 0
  private catalogHash = ''
  private manifests = new Map<string, CapabilityCapsuleManifestV1>()

  constructor(ctx: Context, private readonly root: string) {
    super(ctx)
  }

  snapshot(request: CapsuleSnapshotRequest): Promise<CapsuleCatalogSnapshot> {
    this.refresh()
    const tags = new Set(request.capabilityTags ?? [])
    const refs = [...this.manifests.entries()]
      .filter(([, manifest]) => tags.size === 0 || manifest.capabilityTags.some(tag => tags.has(tag)))
      .map(([ref]) => CapabilityCapsuleRef(ref))
      .sort()
    return Promise.resolve({
      revision: this.revision,
      generatedAt: new Date().toISOString(),
      refs,
      catalogSha256: canonicalSha256(refs),
    })
  }

  get(ref: CapabilityCapsuleRef): Promise<CapabilityCapsuleManifestV1> {
    this.refresh()
    const manifest = this.manifests.get(String(ref))
    if (manifest === undefined) {
      throw new CapabilityCapsuleError(`capability capsule not found: ${String(ref)}`, 'CAPSULE_NOT_FOUND')
    }
    return Promise.resolve(structuredClone(manifest))
  }

  async resolve(request: CapsuleResolutionRequest): Promise<CapabilityBindingPlanV1> {
    const snapshot = await this.snapshot({ capabilityTags: request.requirements.map(value => value.capability) })
    const catalog = [...this.manifests.entries()]
    const selected = new Map<string, CapabilityCapsuleManifestV1>()
    const blockers: { code: string; message: string }[] = []
    for (const requirement of request.requirements) {
      const preferred = new Set(requirement.preferredCapsuleIds ?? [])
      const candidates = catalog.filter(([, manifest]) => manifest.capabilityTags.includes(requirement.capability))
      candidates.sort((left, right) => Number(preferred.has(right[1].id))
        - Number(preferred.has(left[1].id)) || left[0].localeCompare(right[0]))
      const candidate = candidates[0]
      if (candidate === undefined) {
        if (requirement.required) blockers.push({
          code: 'CAPABILITY_UNSATISFIED',
          message: `no capsule provides required capability ${requirement.capability}`,
        })
        continue
      }
      selected.set(candidate[0], candidate[1])
    }
    const manifests = [...selected.values()]
    const resolvedCapabilities = union(manifests.map(value => value.capabilityTags))
    for (const capability of resolvedCapabilities) {
      if (!within(capability, request.capabilityBudget)) blockers.push({
        code: 'CAPABILITY_AUTHORITY_EXCEEDED', message: `capsule capability exceeds graph budget: ${capability}`,
      })
    }
    const effectiveEffects = Object.fromEntries(effectValues(EMPTY_EFFECTS).map(([kind]) => [
      kind,
      union(manifests.map(value => value.effects[kind])),
    ])) as unknown as CapabilityEffectSet
    for (const [kind, values] of effectValues(effectiveEffects)) {
      for (const value of values) {
        if (!within(value, request.effectBudget[kind])) blockers.push({
          code: 'CAPABILITY_AUTHORITY_EXCEEDED', message: `capsule ${kind} effect exceeds graph budget: ${value}`,
        })
      }
    }
    const secretRefs = union(manifests.map(value => value.bindings.secretRefs))
    for (const ref of secretRefs) {
      if (!request.approvedSecretRefs.includes(ref)) blockers.push({
        code: 'CAPABILITY_AUTHORITY_EXCEEDED', message: `capsule secret is not approved by the graph: ${ref}`,
      })
    }
    const toolsAllow = union(manifests.map(value => value.bindings.toolsAllow))
    const mcpServers = union(manifests.map(value => value.bindings.mcpServers))
    const injectionKinds = new Set(request.operatorInjectionKinds ?? [])
    if (toolsAllow.length > 0 && !injectionKinds.has('tool')) blockers.push({
      code: 'CAPABILITY_UNSATISFIED', message: 'selected operator does not support tool-policy injection',
    })
    if (mcpServers.length > 0 && !injectionKinds.has('mcp')) blockers.push({
      code: 'CAPABILITY_UNSATISFIED', message: 'selected operator does not support MCP injection',
    })
    const refs = [...selected.keys()].sort().map(CapabilityCapsuleRef)
    const base = {
      version: 1 as const,
      catalogRevision: snapshot.revision,
      catalogSha256: snapshot.catalogSha256,
      capsuleRefs: refs,
      instructions: manifests.flatMap(manifest => manifest.bindings.instructions.map(text => ({
        ref: CapabilityCapsuleRef(`${manifest.id}@${manifest.capsuleVersion}#${manifest.digest}`),
        digest: canonicalSha256(text),
        text,
      }))),
      resourceRefs: union(manifests.map(value => value.bindings.resourceRefs)),
      dataRefs: union(manifests.map(value => value.bindings.dataRefs)),
      toolsAllow,
      toolsDeny: union(manifests.map(value => value.bindings.toolsDeny)),
      mcpServers,
      secretRefs,
      guardRefs: union(manifests.map(value => value.bindings.guardRefs)),
      resolvedCapabilities,
      effectiveEffects,
      effectiveReadScopes: [...request.readScopes].sort(),
      effectiveWriteScopes: [...request.writeScopes].sort(),
      verification: union(manifests.map(value => value.verification)),
      blockers,
    }
    return { ...base, planSha256: canonicalSha256(base) }
  }

  private refresh(): void {
    const next = new Map<string, CapabilityCapsuleManifestV1>()
    const builtin = cleanTaskContextCapsule()
    next.set(`${builtin.id}@${builtin.capsuleVersion}#${builtin.digest}`, builtin)
    const browser = browserCapsule()
    next.set(`${browser.id}@${browser.capsuleVersion}#${browser.digest}`, browser)
    if (existsSync(this.root)) {
      for (const filename of readdirSync(this.root).filter(value => value.endsWith('.json')).sort()) {
        const manifest = validateManifest(JSON.parse(readFileSync(join(this.root, filename), 'utf8')), filename)
        const ref = `${manifest.id}@${manifest.capsuleVersion}#${manifest.digest}`
        if (next.has(ref)) throw new CapabilityCapsuleError(`duplicate capability capsule: ${ref}`, 'CAPSULE_INVALID')
        next.set(ref, manifest)
      }
    }
    const hash = canonicalSha256([...next.entries()])
    if (hash !== this.catalogHash) {
      this.catalogHash = hash
      this.revision += 1
      this.manifests = next
    }
  }
}
