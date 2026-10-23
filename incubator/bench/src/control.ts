/**
 * Owner-only Remote service over the experiment ledgers: lists them and
 * serves one experiment's records with their analysis. It never starts runs
 * and reads nothing outside the configured ledger root.
 * @module @lisihao/dsh-solar-bench/control
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { analyzeExperiment } from './analysis.js'
import type { BenchDetailInput, BenchExperimentDetail, BenchExperimentList, BenchExperimentListItem, BenchLedgersApi } from './contracts.js'
import type { BenchRuntime } from './runtime.js'
import type { AnalysisOptions } from './types.js'

const detailInput = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) })

/** Remote service name; also the client's `remote.<name>` key. */
export const BENCH_LEDGERS_SERVICE = 'solarBenchLedgers'

/**
 * Read the ledgers through the runtime.
 * @param runtime - the runtime owning the ledger root.
 * @param analysis - analysis settings applied to every served experiment.
 * @returns the read API, independent of the Remote carrier.
 */
export function createLedgersApi(runtime: BenchRuntime, analysis: AnalysisOptions): BenchLedgersApi {
  return {
    async list(): Promise<BenchExperimentList> {
      const experiments: BenchExperimentListItem[] = []
      const unreadable: BenchExperimentList['unreadable'] = []
      for (const id of await runtime.experiments()) {
        let snapshot
        try {
          snapshot = await runtime.ledger(id)
        } catch (error) {
          unreadable.push({ id, message: (error as Error).message })
          continue
        }
        // A ledger removed between listing and reading is simply no longer listed.
        if (snapshot === undefined) continue
        const ends = snapshot.records.map(record => record.endedAt)
        experiments.push({
          id,
          suite: snapshot.experiment.suite,
          variants: snapshot.experiment.variants.map(variant => variant.id),
          repetitions: snapshot.experiment.repetitions,
          runs: snapshot.records.length,
          lastEndedAt: ends.length === 0 ? null : Math.max(...ends),
        })
      }
      return { root: runtime.ledgerRoot, experiments, unreadable }
    },
    async detail(input: BenchDetailInput): Promise<BenchExperimentDetail> {
      const { id } = detailInput.parse(input)
      const snapshot = await runtime.ledger(id)
      if (snapshot === undefined) throw new Error(`BENCH_EXPERIMENT_NOT_FOUND: no experiment ${JSON.stringify(id)}`)
      return { ...snapshot, analysis: analyzeExperiment(snapshot.experiment, snapshot.records, analysis) }
    },
  }
}

/** `ctx.solarBenchLedgers`: the read API exposed to the local owner's client. */
export class BenchLedgersControl extends TypertRemoteService {
  /**
   * @param ctx - plugin context.
   * @param api - the read API.
   */
  constructor(ctx: Context, private readonly api: BenchLedgersApi) {
    super(ctx, BENCH_LEDGERS_SERVICE)
  }

  private owner(): void {
    if (this.ctx.invocation !== undefined && this.ctx.invocation.peer.principal.kind !== 'owner') {
      throw new Error('LOCAL_OWNER_REQUIRED: benchmark records are readable only by the local owner.')
    }
  }

  @Remote
  async list(): Promise<BenchExperimentList> {
    this.owner()
    return this.api.list()
  }

  @Remote
  async detail(input: BenchDetailInput): Promise<BenchExperimentDetail> {
    this.owner()
    return this.api.detail(input)
  }
}

declare module '@deepseek-ai/cordis' { interface Context { solarBenchLedgers: BenchLedgersControl } }
