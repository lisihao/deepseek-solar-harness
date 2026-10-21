/**
 * Consumer of the benchmark capability: a read-only HTTP API on the Host web
 * server that lists experiment ledgers and serves one experiment's records
 * with their analysis. Requests are authorized like every Host dashboard:
 * loopback requests from a loopback origin, or a paired device's bearer
 * token. The API never starts runs or reads files outside the ledger root.
 *
 * @module @deepseek-ai/dsh-bench-web
 */

import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { analyzeExperiment } from '@deepseek-ai/dsh-bench-runner'
import type { AnalysisOptions } from '@deepseek-ai/dsh-bench-runner'
import { authorizeRemoteRequest } from '@deepseek-ai/dsh-host-remote-auth'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { BENCH_API_PATH } from './contracts.ts'
import type { BenchApiError, BenchExperimentDetail, BenchExperimentList, BenchExperimentListItem } from './contracts.ts'

export { BENCH_API_PATH } from './contracts.ts'
export type * from './contracts.ts'

/** Cordis plugin name. */
export const name = 'bench-web'
/** The runtime owns the ledgers; the web server carries the routes. */
export const inject = ['benchRuntime', 'webServer']

/** Analysis settings applied to every served experiment. */
export type Config = AnalysisOptions

export const Config: z<Config> = z.object({
  confidence: z.union([z.const(0.9), z.const(0.95), z.const(0.99)]).default(0.95),
  resamples: z.natural().min(100).default(2000),
  seed: z.natural().default(1),
  margin: z.number().min(0).max(0.99).default(0.05),
  minTasks: z.natural().min(3).default(10),
  invalidTolerance: z.number().min(0).max(1).default(0.1),
})

const EXPERIMENTS_PATH = `${BENCH_API_PATH}/experiments`

/**
 * Send a JSON body that is never cached.
 * @param response - the response.
 * @param status - HTTP status.
 * @param body - the body.
 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body))
  response.statusCode = status
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', encoded.byteLength)
  response.end(encoded)
}

/**
 * Send an error body.
 * @param response - the response.
 * @param status - HTTP status.
 * @param error - the error body.
 */
function sendError(response: ServerResponse, status: number, error: BenchApiError): void {
  sendJson(response, status, error)
}

/**
 * Mount the read API.
 * @param ctx - context carrying `ctx.benchRuntime` and `ctx.webServer`.
 * @param config - analysis settings.
 */
export function apply(ctx: Context, config: Config): void {
  const list = async (): Promise<BenchExperimentList> => {
    const experiments: BenchExperimentListItem[] = []
    for (const id of await ctx.benchRuntime.experiments()) {
      const snapshot = await ctx.benchRuntime.ledger(id)
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
    return { experiments }
  }

  const detail = async (id: string): Promise<BenchExperimentDetail | undefined> => {
    const snapshot = await ctx.benchRuntime.ledger(id)
    if (snapshot === undefined) return undefined
    return { ...snapshot, analysis: analyzeExperiment(snapshot.experiment, snapshot.records, config) }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BENCH_API_PATH,
    handler: async (request, response) => {
      const remoteAuth = ctx.get('remoteAuth')
      if (authorizeRemoteRequest(request, remoteAuth) === undefined) {
        if (remoteAuth === undefined) sendError(response, 503, { error: 'REMOTE_AUTH_UNAVAILABLE' })
        else sendError(response, 401, { error: 'UNAUTHORIZED' })
        return
      }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const id = path.startsWith(`${EXPERIMENTS_PATH}/`) ? decodeURIComponent(path.slice(EXPERIMENTS_PATH.length + 1)) : undefined
      if (path !== EXPERIMENTS_PATH && (id === undefined || id === '' || id.includes('/'))) {
        sendError(response, 404, { error: 'NOT_FOUND' })
        return
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        sendError(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      try {
        if (id === undefined) {
          sendJson(response, 200, await list())
          return
        }
        const body = await detail(id)
        if (body === undefined) sendError(response, 404, { error: 'NOT_FOUND', message: `no experiment ${JSON.stringify(id)}` })
        else sendJson(response, 200, body)
      } catch (error) {
        sendError(response, 500, { error: 'READ_FAILED', message: (error as Error).message })
      }
    },
  }), 'bench-web routes')
}
