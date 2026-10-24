/**
 * Per-run isolation and session readback. Every run gets a fresh directory
 * holding its workspace, a private `$DSH_HOME` seeded from the template home,
 * and a state directory for plugin state kept outside `$DSH_HOME`; after the
 * run, its sessions are read through the real JSONL persistence backend.
 * @module @lisihao/dsh-solar-bench/cell
 */

import { constants, cp, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Variant } from './types.js'

/** Directories of one prepared run. */
export interface CellDirs {
  /** Agent working directory, seeded from the task fixture. */
  workspace: string
  /** Private `$DSH_HOME`. */
  home: string
  /** Private state directory that `{cell}` in variant env expands to. */
  state: string
}

/** What a run's home is seeded from. */
export interface HomeTemplate {
  /** Absolute home whose `profiles/<profile>` directory is copied. */
  home: string
  /** Absolute home the listed files are copied from; defaults to `home`. */
  filesHome?: string
  /** Home-relative files copied into each run home when present, such as credentials and settings. */
  files: readonly string[]
}

/**
 * Create a fresh run directory, replacing any partial one left by a crash.
 * Copies request copy-on-write clones, so a profile's `node_modules` costs
 * little per run where the filesystem supports them.
 * @param dir - absolute run directory.
 * @param fixture - task fixture directory, if any.
 * @param template - home template.
 * @param profile - profile the run boots.
 * @returns the run's directories.
 */
export async function prepareCell(dir: string, fixture: string | undefined, template: HomeTemplate, profile: string): Promise<CellDirs> {
  await rm(dir, { recursive: true, force: true })
  const dirs: CellDirs = { workspace: join(dir, 'workspace'), home: join(dir, 'home'), state: join(dir, 'state') }
  await mkdir(dirs.state, { recursive: true })
  const copy = { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE }
  if (fixture === undefined) await mkdir(dirs.workspace, { recursive: true })
  else await cp(fixture, dirs.workspace, copy)
  await cp(join(template.home, 'profiles', profile), join(dirs.home, 'profiles', profile), copy)
  for (const file of template.files) {
    const source = join(template.filesHome ?? template.home, file)
    // An absent template file is allowed: credentials may come from the environment instead.
    if (await stat(source).then(() => true, () => false)) await cp(source, join(dirs.home, file), copy)
  }
  return dirs
}

/**
 * Delete the template files copied into a run home, so finished runs, which
 * are kept on disk, do not each hold a copy of the credentials.
 * @param home - the run's `$DSH_HOME`.
 * @param files - the home-relative template files.
 */
export async function scrubTemplateFiles(home: string, files: readonly string[]): Promise<void> {
  for (const file of files) await rm(join(home, file), { force: true })
}

/**
 * Child environment of one run.
 * @param base - inherited environment.
 * @param dirs - the run's directories.
 * @param variant - the variant whose `env` is expanded.
 * @returns `base` plus `DSH_HOME` and the variant's expanded entries.
 */
/**
 * Variables of the desktop host process kept out of a run child, so an
 * in-app run starts like a shell run: Node's IPC channel to the host (the
 * child is spawned without that fd) and the host's client identity. A
 * launcher started with `NODE_CHANNEL_FD=3` and no fd 3 still printed its
 * help, so this is hygiene, not a fix for an observed failure.
 */
const HOST_ONLY_ENV = ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID', 'DSH_CLIENT_VERSION']

export function cellEnv(base: NodeJS.ProcessEnv, dirs: CellDirs, variant: Variant): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DSH_HOME: dirs.home }
  for (const name of HOST_ONLY_ENV) delete env[name]
  for (const [name, value] of Object.entries(variant.env)) env[name] = value.replaceAll('{cell}', dirs.state)
  return env
}

/** Session logs of one run. */
export interface RunSessions {
  /** Events of the top-level session. */
  root: SessionEvent[]
  /** Events of every subagent child session. */
  children: SessionEvent[][]
}

/**
 * Read every session a run persisted under its home.
 * @param home - the run's `$DSH_HOME`.
 * @returns the root session and its children.
 * @throws Error when the run did not persist exactly one top-level session.
 */
export async function readRunSessions(home: string): Promise<RunSessions> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
    const snapshots = await ctx.sessionPersistence.list()
    // The JSONL backend writes delegationDepth on every header; 0 marks a top-level session.
    const roots = snapshots.filter(snapshot => snapshot.header.delegationDepth === 0)
    if (roots.length !== 1) throw new Error(`expected one top-level session, found ${String(roots.length)}`)
    const sessions: RunSessions = { root: [], children: [] }
    for (const snapshot of snapshots) {
      const handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
      try {
        const { events } = await handle.read()
        if (snapshot === roots[0]) sessions.root = [...events]
        else sessions.children.push([...events])
      } finally {
        await handle.close()
      }
    }
    return sessions
  } finally {
    await ctx.fiber.dispose()
  }
}
