/** Current-process Host admission and one SQLite owner for external research actions. */
import type { Context } from '@deepseek-ai/cordis'
import ResearchHandoffService, {
  ResearchActionError, ResearchControlError, type ResearchActionRequest, type ResearchActionSnapshot, type ResearchDriverId,
  type ResearchDriverRequest, type ResearchDriverReceipt, type ResearchDriverObservation,
  type ResearchOwnerId, type ResearchHostControl, type ResearchHostPolicy, type ResearchHostScope, type ResearchSubmissionGuard,
  type ResearchHostRegistration, type ResearchPlatformDriver, type ResearchSourceReader, type ResearchSourceReaderId,
  type ResearchSourceAccess, type ResearchSourceReadRequest, type ResearchSourceReadSnapshot, type ResearchRunId, type ResearchSourceReadId,
  type ResearchWorkflowId, type ResearchWorkflowCollector, type ResearchWorkflowOutput, type ResearchAcceptedResource,
} from '@deepseek-ai/dsh-research-handoff'
import { ResearchActionStore, researchActionFingerprint, researchModeFingerprint } from './action-store.ts'
import { splitResearchArtifact } from './artifact.ts'
import { researchSourceUrl } from './source-read.ts'

type DriverEntry = { driver: ResearchPlatformDriver; revoked: AbortController }
type HostGrant = {
  policy: ResearchHostPolicy
  revoked: AbortController
  sourceAccess: ResearchSourceAccess | undefined
  scope: ResearchHostScope | undefined
}
type SourceEntry = { reader: ResearchSourceReader; revoked: AbortController }

function targetJson(target: ResearchActionRequest['target']): string {
  return JSON.stringify({ workspace: target.workspace, page: target.page, conversation: target.conversation })
}

function resourceJson(value: ResearchAcceptedResource): string {
  return JSON.stringify({ workspace: value.workspace, page: value.page, conversation: value.conversation,
    report: value.report, evidence: value.evidence })
}

/** Local Provider in the embedding Host's broad same-process trust domain. */
export class LocalResearchHandoffService extends ResearchHandoffService {
  private readonly store: ResearchActionStore
  private readonly drivers = new Map<ResearchDriverId, DriverEntry>()
  private readonly readers = new Map<ResearchSourceReaderId, SourceEntry>()
  private readonly hosts = new WeakMap<Context, HostGrant>()
  private readonly liveHosts = new Set<HostGrant>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly collecting = new Set<string>()
  private closing = false
  private closed: Promise<void> | undefined

  /**
   * Open one explicitly configured private database; old formats fail before service use.
   * @param ctx - Provider lifecycle.
   * @param filename - Explicit private SQLite file.
   */
  constructor(ctx: Context, filename: string) {
    super(ctx)
    this.store = new ResearchActionStore(filename)
    ctx.effect(() => () => this.close(), 'research Provider database owner')
  }

  registerDriver(owner: Context, driver: ResearchPlatformDriver): () => Promise<void> {
    if (this.closing || this.drivers.has(driver.id)) throw new ResearchControlError('Driver registration unavailable', 'POLICY')
    const entry: DriverEntry = { driver: Object.freeze({ id: driver.id, platform: driver.platform,
      qualify: driver.qualify.bind(driver), execute: driver.execute.bind(driver), observe: driver.observe.bind(driver) }),
    revoked: new AbortController() }
    return owner.effect(() => {
      this.drivers.set(driver.id, entry)
      return () => {
        if (this.drivers.get(driver.id) === entry) this.drivers.delete(driver.id)
        entry.revoked.abort(new Error('research Driver registration revoked'))
      }
    }, 'research Driver registration')
  }

  bindHost(host: Context, policy: ResearchHostPolicy, sourceAccess?: ResearchSourceAccess,
    scope?: ResearchHostScope): ResearchHostRegistration {
    scope?.assertCurrent()
    if (this.closing || !policy.version || !policy.ownerId || !policy.workspace
      || !['imported', 'model', 'human'].includes(policy.judgmentChannel)
      || !Number.isSafeInteger(policy.inputMaxBytes) || policy.inputMaxBytes < 1
      || policy.drivers.length === 0 || new Set(policy.drivers.map(x => x.id)).size !== policy.drivers.length) {
      throw new ResearchControlError('explicit research Host bounds required', 'POLICY')
    }
    if (sourceAccess !== undefined && new Set(sourceAccess.readers).size !== sourceAccess.readers.length) {
      throw new ResearchControlError('duplicate source Reader selection', 'POLICY')
    }
    const access = sourceAccess === undefined ? undefined : { readers: [...sourceAccess.readers],
      authorizeSourceUrl: sourceAccess.authorizeSourceUrl.bind(sourceAccess) }
    const grant: HostGrant = { policy: structuredClone(policy), revoked: new AbortController(), sourceAccess: access,
      scope: scope === undefined ? undefined : { assertCurrent: scope.assertCurrent.bind(scope) } }
    const dispose = host.effect(() => {
      const previous = this.hosts.get(host)
      previous?.revoked.abort(new Error('research Host policy replaced'))
      if (previous !== undefined) this.liveHosts.delete(previous)
      this.hosts.set(host, grant)
      this.liveHosts.add(grant)
      return () => {
        if (this.hosts.get(host) === grant) this.hosts.delete(host)
        this.liveHosts.delete(grant)
        grant.revoked.abort(new Error('research Host registration revoked'))
      }
    }, 'research current Host registration')
    const owner = grant.policy.ownerId
    const check = (): void => { this.assertHost(grant) }
    const control: ResearchHostControl = {
      ownerId: owner,
      readWorkflowState: (id) => { check(); return this.store.readWorkflowState(owner, id) },
      previewWorkflowStage: (id, kind, preview) => { check(); return this.store.workflowPreviews.standard(owner, id, kind, preview) },
      readWorkflowStage: (id, kind) => { check(); return this.store.workflowDeliveries.read(owner, id, kind) },
      readWorkflowDeliveryDisposition: (id, disposition) => {
        check(); return this.store.workflowDeliveries.readTreatment(owner, id, disposition)
      },
      appendWorkflowDeliveryDisposition: (id, input, assertHuman) => {
        check()
        assertHuman()
        check()
        if (grant.policy.judgmentChannel !== 'human') throw new ResearchControlError('actual human entry required', 'POLICY')
        return this.store.workflowDeliveries.append(owner, id, input, { channel: 'human', ownerId: owner,
          hostPolicyVersion: grant.policy.version })
      },
      claimWorkflowDefinition: (id, input) => { check(); return this.store.workflows.claim(owner, id, input) },
      readWorkflowDefinition: (id) => { check(); return this.store.workflows.read(owner, id) },
      previewWorkflowAction: (id, input) => { check(); return this.store.workflowPreviews.create(owner, id, input) },
      readWorkflowPreview: (id, preview) => { check(); return this.store.workflowPreviews.read(owner, id, preview) },
      confirmWorkflowPreview: (id, preview, sha, assertHuman) => {
        check()
        assertHuman()
        check()
        if (grant.policy.judgmentChannel !== 'human') throw new ResearchControlError('actual human entry required', 'POLICY')
        return this.store.workflowPreviews.confirm(owner, id, preview, sha, { channel: 'human',
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      freezeWorkflowPreview: (id, preview, sha) => { check(); return this.store.workflowPreviews.freeze(owner, id, preview, sha) },
      captureWorkflowOutput: (id, workflow, action, collector, signal) =>
        this.collectWorkflowOutput(grant, id, workflow, action, collector, signal),
      readWorkflowOutputs: (id, workflow) => { check(); return this.store.workflows.outputs(owner, id, workflow) },
      readDeliveryRecords: (id, action) => { check(); return this.store.deliveries.read(owner, id, action) },
      readFinalStatus: (id) => { check(); return this.store.finalDecisions.readStatus(owner, id) },
      recordFinalDecision: (id, decision) => {
        check()
        return this.store.finalDecisions.record(owner, id, decision, { channel: grant.policy.judgmentChannel,
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      readFinalDecision: (id, decision) => { check(); return this.store.finalDecisions.read(owner, id, decision) },
      appendFinalMap: (id, input) => {
        check()
        return this.store.finalMaps.append(owner, id, input, { channel: grant.policy.judgmentChannel,
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      readFinalMap: (id, map) => { check(); return this.store.finalMaps.read(owner, id, map) },
      confirmFinalMap: (id, map, sha) => {
        check()
        return this.store.finalMaps.confirm(owner, id, map, sha, { channel: grant.policy.judgmentChannel,
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      appendCounterDisposition: (id, input) => {
        check()
        return this.store.dispositions.append(owner, id, input, { channel: grant.policy.judgmentChannel,
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      readCounterDisposition: (id, disposition) => { check(); return this.store.dispositions.read(owner, id, disposition) },
      readCounterDispositions: (id, target) => { check(); return this.store.dispositions.readTarget(owner, id, target) },
      appendCitationAssessment: (id, input) => {
        check()
        return this.store.citations.append(owner, id, input, { channel: grant.policy.judgmentChannel,
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      readCitationAssessment: (id, citation) => { check(); return this.store.citations.read(owner, id, citation) },
      readCitationAssessments: (id, version) => { check(); return this.store.citations.readInventory(owner, id, version) },
      readSource: (request, signal) => this.sourceRead(grant, request, signal),
      readSourceRecord: (id, read) => { check(); return this.store.sourceReads.read(owner, id, read) },
      observeSourceRead: (id, read, signal) => this.sourceObserve(grant, id, read, signal),
      modeFingerprint: (id) => {
        check()
        const choice = grant.policy.drivers.find(x => x.id === id)
        if (choice === undefined) throw new ResearchControlError('Driver not selected by Host', 'POLICY')
        return researchModeFingerprint(id, choice.selection)
      },
      create: (id, binding) => { check(); return this.store.create(owner, id, binding) },
      inspect: (id) => { check(); return this.store.inspect(owner, id) },
      revise: (id, revision, binding) => { check(); return this.store.revise(owner, id, revision, binding) },
      confirm: (id, revision, sha) => { check(); return this.store.confirm(owner, id, revision, sha) },
      execute: (request, signal, guard) => this.execute(grant, request, signal, guard),
      preparePrompt: (id, input) => { check(); return this.store.preparePrompt(owner, id, input) },
      readPreparedPrompt: (id, input) => { check(); return this.store.readPreparedPrompt(owner, id, input) },
      readAction: (id, action) => { check(); return this.store.readAction(owner, id, action) },
      readQualification: (id, action) => { check(); return this.store.readQualification(owner, id, action) },
      observe: (id, action, signal) => this.track(async () => {
        this.assertHost(grant)
        const snapshot = this.store.readAction(owner, id, action)
        const entry = this.admit(grant, snapshot.request)
        const combined = this.signal(grant, entry, signal)
        this.assertCurrent(grant, entry, snapshot.request, combined)
        const input = this.driverInput(snapshot)
        const observation = await entry.driver.observe(input, combined)
        this.assertActionReceipt(owner, input, observation)
        if (observation.state !== 'unknown') {
          const retained = this.store.recordObservation(owner, id, action, snapshot.inputSha256, observation)
          const delivery = observation.delivery
          if (delivery !== undefined) this.store.deliveries.record(owner, id, action, snapshot.inputSha256, delivery)
          return retained
        }
        return this.store.readAction(owner, id, action)
      }),
      captureArtifact: (id, input) => { check(); return this.store.captureArtifact(owner, id, input) },
      readArtifact: (id, artifact) => { check(); return this.store.readArtifact(owner, id, artifact) },
      splitArtifact: (id, artifact, max) => { check(); return splitResearchArtifact(this.store.readArtifact(owner, id, artifact), max) },
      appendClaimInventory: (id, input) => { check(); return this.store.appendClaimInventory(owner, id, input) },
      readClaimInventory: (id, version) => { check(); return this.store.readClaimInventory(owner, id, version) },
      confirmClaimInventory: (id, version, sha) => { check(); return this.store.confirmClaimInventory(owner, id, version, sha) },
      appendClaimJudgment: (id, input) => {
        check()
        return this.store.appendClaimJudgment(owner, id, input, { channel: grant.policy.judgmentChannel,
          ownerId: owner, hostPolicyVersion: grant.policy.version })
      },
      readClaimJudgments: (id, version, after, limit) => {
        check(); return this.store.readClaimJudgments(owner, id, version, after, limit)
      },
      readObservations: (id, after, limit) => { check(); return this.store.readObservations(owner, id, after, limit) },
    }
    return { control: Object.freeze(control), dispose }
  }

  registerSourceReader(owner: Context, reader: ResearchSourceReader): () => Promise<void> {
    if (this.closing || this.readers.has(reader.id)) throw new ResearchControlError('source Reader unavailable', 'POLICY')
    const entry: SourceEntry = { reader: Object.freeze({ id: reader.id, read: reader.read.bind(reader),
      observe: reader.observe.bind(reader) }), revoked: new AbortController() }
    return owner.effect(() => {
      this.readers.set(reader.id, entry)
      return () => {
        if (this.readers.get(reader.id) === entry) this.readers.delete(reader.id)
        entry.revoked.abort(new Error('source Reader registration revoked'))
      }
    }, 'research source Reader registration')
  }

  private admitSource(grant: HostGrant, request: ResearchSourceReadRequest, entry: SourceEntry, signal: AbortSignal,
    operation: 'visit' | 'observe' = 'visit'): void {
    this.assertHost(grant)
    signal.throwIfAborted()
    const run = this.store.inspect(grant.policy.ownerId, request.runId)
    if (grant.sourceAccess === undefined || !grant.sourceAccess.readers.includes(request.readerId)
      || this.readers.get(request.readerId) !== entry || entry.revoked.signal.aborted
      || operation === 'visit' && (run.revision !== request.revision || run.bindingSha256 !== request.bindingSha256 || !run.confirmed)
      || !grant.policy.sourceConfigurationSha256s.includes(run.binding.sourcesSha256)) {
      throw new ResearchControlError('source request exceeds current Host admission', 'POLICY')
    }
  }

  private sourceRead(grant: HostGrant, request: ResearchSourceReadRequest, signal?: AbortSignal): Promise<ResearchSourceReadSnapshot> {
    return this.track(async () => {
      this.assertHost(grant)
      const entry = this.readers.get(request.readerId)
      const access = grant.sourceAccess
      if (entry === undefined || access === undefined) {
        throw new ResearchControlError('source Reader not enabled by current Host', 'DRIVER_UNSUPPORTED')
      }
      const combined = AbortSignal.any([grant.revoked.signal, entry.revoked.signal, ...(signal === undefined ? [] : [signal])])
      this.admitSource(grant, request, entry, combined)
      const { snapshot, created } = this.store.sourceReads.begin(grant.policy.ownerId, request)
      if (!created) return snapshot
      let first = true
      const beforeVisit = (actualUrl: string): void => {
        this.admitSource(grant, snapshot.request, entry, combined)
        const url = researchSourceUrl(actualUrl)
        if (first && url !== snapshot.request.requestedUrl) throw new ResearchControlError('initial source target changed', 'POLICY')
        const permission = access.authorizeSourceUrl(structuredClone(snapshot.request), url)
        this.admitSource(grant, snapshot.request, entry, combined)
        if (!permission.allowed || !permission.evidence) throw new ResearchControlError('source target not authorized', 'POLICY')
        this.store.sourceReads.guard(grant.policy.ownerId, snapshot, url, permission.evidence)
        first = false
      }
      const reply = await entry.reader.read({ request: structuredClone(snapshot.request),
        requestSha256: snapshot.requestSha256, resource: null }, combined, beforeVisit)
      return this.store.sourceReads.record(grant.policy.ownerId, snapshot, reply)
    })
  }

  private sourceObserve(grant: HostGrant, runId: ResearchRunId, readId: ResearchSourceReadId,
    signal?: AbortSignal): Promise<ResearchSourceReadSnapshot> {
    return this.track(async () => {
      this.assertHost(grant)
      const original = this.store.sourceReads.read(grant.policy.ownerId, runId, readId)
      if (original.resource === null || ['completed', 'not-admitted'].includes(original.state)) return original
      const entry = this.readers.get(original.request.readerId)
      if (entry === undefined) throw new ResearchControlError('original source Reader unavailable', 'DRIVER_UNSUPPORTED')
      const combined = AbortSignal.any([grant.revoked.signal, entry.revoked.signal, ...(signal === undefined ? [] : [signal])])
      this.admitSource(grant, original.request, entry, combined, 'observe')
      const access = grant.sourceAccess
      if (access === undefined) throw new ResearchControlError('source access unavailable', 'POLICY')
      for (const url of original.authorizedUrls) {
        const permission = access.authorizeSourceUrl(structuredClone(original.request), url)
        this.admitSource(grant, original.request, entry, combined, 'observe')
        if (!permission.allowed || !permission.evidence) throw new ResearchControlError('source observation not authorized', 'POLICY')
      }
      const reply = await entry.reader.observe({ request: structuredClone(original.request),
        requestSha256: original.requestSha256, resource: structuredClone(original.resource) }, combined)
      return this.store.sourceReads.record(grant.policy.ownerId, original, reply)
    })
  }


  private collectWorkflowOutput(grant: HostGrant, runId: ResearchRunId, workflowId: ResearchWorkflowId,
    actionId: ResearchActionRequest['actionId'], collector: ResearchWorkflowCollector, signal?: AbortSignal): Promise<ResearchWorkflowOutput> {
    this.assertHost(grant)
    const owner = grant.policy.ownerId, key = JSON.stringify([owner, runId, workflowId, actionId])
    if (this.collecting.has(key)) return Promise.reject(new ResearchActionError('original workflow collection is in flight', 'PENDING'))
    this.collecting.add(key)
    return this.track(async () => {
      this.assertHost(grant)
      const canonical = this.store.workflows.read(owner, runId)
      if (canonical?.input.workflowId !== workflowId) throw new ResearchActionError('canonical workflow differs', 'CONFLICT')
      const snapshot = this.store.readAction(owner, runId, actionId)
      if (snapshot.state !== 'completed' || snapshot.acceptedResource === null
        || !canonical.input.stages.some(x => x.actionId === actionId && x.kind === snapshot.request.kind
          && x.stepId === snapshot.request.stepId && x.preparedPromptId === snapshot.request.preparedPromptId)) {
        throw new ResearchActionError('original workflow stage is not completed with a correlated resource', 'PENDING')
      }
      const entry = this.admit(grant, snapshot.request), combined = this.signal(grant, entry, signal)
      const guard = (): void => { this.assertCurrent(grant, entry, snapshot.request, combined) }
      guard()
      const observed = structuredClone(await collector.collect({ runId, workflowId, snapshot: structuredClone(snapshot) }, combined, guard))
      if (observed.actionId !== actionId || observed.requestSha256 !== snapshot.inputSha256
        || resourceJson(observed.resource) !== resourceJson(snapshot.acceptedResource)) {
        throw new ResearchActionError('collected output differs from the admitted original resource', 'CONFLICT')
      }
      // This already admitted read may return after revocation; retain its fact before the Consumer stops advancement.
      return this.store.workflows.capture(owner, runId, workflowId, observed)
    }).finally(() => this.collecting.delete(key))
  }

  private assertHost(grant: HostGrant): void {
    this.assertGrant(grant)
    grant.scope?.assertCurrent()
    this.assertGrant(grant)
  }

  private assertGrant(grant: HostGrant): void {
    if (this.closing || grant.revoked.signal.aborted || !this.liveHosts.has(grant)) {
      throw new ResearchControlError('current research Host registration revoked', 'HOST_REVOKED')
    }
  }

  private admit(grant: HostGrant, request: ResearchActionRequest): DriverEntry {
    this.assertHost(grant)
    const policy = grant.policy
    const choice = policy.drivers.find(x => x.id === request.driverId)
    const entry = this.drivers.get(request.driverId)
    const platform = request.kind.startsWith('gemini-') ? 'gemini' : 'chatgpt'
    if (choice === undefined || entry === undefined || entry.driver.platform !== platform || choice.platform !== platform
      || request.binding.modeSha256 !== researchModeFingerprint(request.driverId, choice.selection)
      || researchModeFingerprint(request.driverId, request.selection) !== request.binding.modeSha256
      || request.target.workspace !== policy.workspace
      || !policy.sourceConfigurationSha256s.includes(request.binding.sourcesSha256)
      || !policy.destinations.some(x => x.bindingSha256 === request.binding.destinationSha256
        && targetJson(x.target) === targetJson(request.target))) {
      throw new ResearchControlError('request exceeds current Host research policy', 'POLICY')
    }
    if (Buffer.byteLength(request.input, 'utf8') > policy.inputMaxBytes) {
      throw new ResearchControlError('full research input exceeds Host capacity', 'INPUT_LIMIT')
    }
    return entry
  }

  private signal(grant: HostGrant, entry: DriverEntry, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([grant.revoked.signal, entry.revoked.signal, ...(signal === undefined ? [] : [signal])])
  }

  private assertCurrent(grant: HostGrant, entry: DriverEntry, request: ResearchActionRequest, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (this.admit(grant, request) !== entry) throw new ResearchControlError('research Driver registration changed', 'POLICY')
  }

  private assertSubmissionCurrent(grant: HostGrant, entry: DriverEntry, request: ResearchActionRequest, signal: AbortSignal): void {
    this.assertCurrent(grant, entry, request, signal)
    const run = this.store.inspect(grant.policy.ownerId, request.runId)
    if (run.revision !== request.revision || run.bindingSha256 !== request.bindingSha256 || !run.confirmed) {
      throw new ResearchActionError('research confirmation changed before submission', 'CONFIRMATION')
    }
    const action = this.store.readAction(grant.policy.ownerId, request.runId, request.actionId)
    if (action.inputSha256 !== researchActionFingerprint(request) || action.state !== 'unknown') {
      throw new ResearchActionError('research action no longer permits first submission', 'CONFLICT')
    }
  }

  private assertActionReceipt(owner: ResearchOwnerId, input: ResearchDriverRequest, receipt: ResearchDriverObservation): void {
    this.assertReceipt(input, receipt)
    if (receipt.state === 'accepted' || receipt.state === 'completed') {
      const current = this.store.readAction(owner, input.request.runId, input.request.actionId)
      if (receipt.acceptedResource === null && current.acceptedResource === null) {
        throw new ResearchControlError('accepted research resource was not correlated', 'DRIVER_NOT_OBSERVED')
      }
    }
  }

  private driverInput(snapshot: ResearchActionSnapshot): ResearchDriverRequest {
    return { request: structuredClone(snapshot.request), requestSha256: snapshot.inputSha256,
      acceptedResource: snapshot.acceptedResource === null ? null : structuredClone(snapshot.acceptedResource) }
  }

  private assertReceipt(input: ResearchDriverRequest,
    receipt: Pick<ResearchDriverReceipt, 'requestSha256' | 'target'>): void {
    if (receipt.requestSha256 !== input.requestSha256 || targetJson(receipt.target) !== targetJson(input.request.target)) {
      throw new ResearchControlError('Driver receipt conflicts with original action', 'POLICY')
    }
  }

  private execute(grant: HostGrant, request: ResearchActionRequest, signal?: AbortSignal,
    guard?: ResearchSubmissionGuard): Promise<ResearchActionSnapshot> {
    return this.track(async () => {
      const entry = this.admit(grant, request)
      const combined = this.signal(grant, entry, signal)
      this.assertCurrent(grant, entry, request, combined)
      const checkRequest = (fixed: ResearchActionRequest): void => {
        guard?.(structuredClone(fixed))
        this.assertCurrent(grant, entry, fixed, combined)
      }
      checkRequest(request)
      let deliveryReceipt: ResearchDriverReceipt | undefined
      const snapshot = await this.store.execute(grant.policy.ownerId, request, async (recorded) => {
        const beforeSubmit = (): void => {
          this.assertSubmissionCurrent(grant, entry, recorded, combined)
          checkRequest(recorded)
          this.assertSubmissionCurrent(grant, entry, recorded, combined)
        }
        beforeSubmit()
        const input = { request: structuredClone(recorded), requestSha256: researchActionFingerprint(recorded), acceptedResource: null }
        const observedQualification = await entry.driver.qualify(input, combined)
        const qualification = this.store.recordQualification(grant.policy.ownerId, recorded.runId, recorded.actionId,
          input.requestSha256, observedQualification).observation
        beforeSubmit()
        if (qualification.status !== 'available') {
          throw new ResearchControlError(qualification.reason,
            qualification.status === 'unsupported' ? 'DRIVER_UNSUPPORTED' : 'DRIVER_NOT_OBSERVED')
        }
        this.assertReceipt(input, qualification)
        if (researchModeFingerprint(recorded.driverId, qualification.selection) !== recorded.binding.modeSha256
          || !qualification.evidence || !Number.isSafeInteger(qualification.inputMaxBytes) || qualification.inputMaxBytes < 1) {
          throw new ResearchControlError('Driver qualification differs from confirmed selection', 'POLICY')
        }
        const requested = recorded.selection.effort
        if (requested.kind === 'required' && (qualification.effort.kind !== 'observed' || qualification.effort.value !== requested.value)
          || requested.kind === 'not-applicable' && qualification.effort.kind !== 'not-applicable') {
          throw new ResearchControlError('requested research effort not observed', 'DRIVER_NOT_OBSERVED')
        }
        if (Buffer.byteLength(recorded.input, 'utf8') > qualification.inputMaxBytes) {
          throw new ResearchControlError('full research input exceeds observed Driver capacity', 'INPUT_LIMIT')
        }
        beforeSubmit()
        const receipt = await entry.driver.execute(input, combined, beforeSubmit)
        this.assertActionReceipt(grant.policy.ownerId, input, receipt)
        deliveryReceipt = receipt
        return receipt
      })
      const delivery = deliveryReceipt?.delivery
      if (delivery !== undefined) {
        this.store.deliveries.record(grant.policy.ownerId, request.runId, request.actionId, snapshot.inputSha256, delivery)
      }
      if (guard !== undefined) checkRequest(snapshot.request)
      return snapshot
    })
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ResearchControlError('research Provider closing', 'HOST_REVOKED'))
    const pending = Promise.withResolvers<T>()
    this.pending.add(pending.promise)
    // The owned fence is visible before operation invokes any reentrant Driver callback.
    void Promise.resolve().then(operation).then(pending.resolve, pending.reject)
    void pending.promise.then(() => this.pending.delete(pending.promise), () => this.pending.delete(pending.promise))
    return pending.promise
  }

  /**
   * Revoke new work and drain owned calls before closing SQLite; remote cancellation is not inferred.
   * @returns Drain completion. A Driver that never returns can keep this promise pending indefinitely.
   */
  close(): Promise<void> {
    if (this.closed !== undefined) return this.closed
    this.closing = true
    for (const grant of this.liveHosts) grant.revoked.abort(new Error('research Provider closing'))
    this.liveHosts.clear()
    for (const entry of this.drivers.values()) entry.revoked.abort(new Error('research Provider closing'))
    this.drivers.clear()
    for (const entry of this.readers.values()) entry.revoked.abort(new Error('research Provider closing'))
    this.readers.clear()
    this.closed = Promise.allSettled([...this.pending]).then(() => { this.store.close() })
    return this.closed
  }
}
