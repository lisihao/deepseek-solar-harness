import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'
const pullRequestImpactIf = "github.event_name == 'pull_request' && needs['pr-impact'].outputs.run_ci != 'false'"
const docsOnlyIf = "github.event_name == 'pull_request' && needs['pr-impact'].outputs.run_ci == 'false' && github.base_ref != 'solar'"

describe('CI workflow', () => {
  it('runs the dynamic Cordis browser lifecycle in a fresh Vitest process', () => {
    const packageJson: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
      throw new TypeError('Root package must define scripts')
    }

    expect(packageJson.scripts['test:web:built']).toBe(
      'npm run test:web:built:main && npm run test:web:built:cordis',
    )
    expect(packageJson.scripts['test:web:built:main']).toContain('DSH_WEB_SUITE=main')
    expect(packageJson.scripts['test:web:built:cordis']).toContain('DSH_WEB_SUITE=isolated')
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')

    const setups = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps.flatMap((step) => {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) return []
        return [{ jobName, step }]
      })
    })

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: { dest: runnerPrivatePnpmDestination },
      })
    }
  })

  it('keeps the required CI DAG Linux/Python-only', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['all-checks-passed'])) {
      throw new TypeError('CI workflow must define node-24, node-24-coverage, node-24-consumers, and all-checks-passed jobs')
    }

    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define needs')
    }

    for (const jobName of ['windows', 'windows-native', 'wine-apt-cache', 'serial-windows']) {
      expect(workflow.jobs).not.toHaveProperty(jobName)
    }
    expect(JSON.stringify(workflow.jobs)).not.toMatch(/windows|wine|pwsh/iu)
    expect(aggregate.needs).not.toEqual(expect.arrayContaining(['windows', 'windows-native', 'wine-apt-cache', 'serial-windows']))

    // The three required Linux workers and the verdict job resolve their pool
    // through DSH_CI_FAILOVER_LINUX.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on']).toContain('vm-backup')
      expect(job['runs-on']).toContain('ubuntu-24.04')
      expect(job['runs-on']).not.toContain('dsh-ubuntu-24-04-16core')
    }
    expect(node24Coverage.name).toBe('node 24 / coverage and semantic snapshots')
    if (!isRecord(node24Coverage.env)) throw new TypeError('Node 24 coverage job must define env')
    expect(node24Coverage.env.DSH_OXLINT_THREADS).toBe('1')
    expect(node24Coverage.env.DSH_SNAPSHOT_MAX_CONCURRENCY).toContain("|| '2'")
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).toContain('vm-backup')
  })

  it('exempts push from cancellation, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('CI workflow must define jobs and a workflow-level concurrency block')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master. The
    // expression is evaluated against the NEWLY TRIGGERED run, so a dispatch on
    // master still cancels a mid-flight drill; the runbook records that bound.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['serial-linux-selfhosted']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only and only allocate when their pool is configured.
      expect(job.if).toContain("github.event_name == 'push' && github.ref == 'refs/heads/master'")
      expect(job.if).toContain('DSH_CI_FAILOVER_LINUX')
    }

    // What bounds the cost of exempting push: a master push may only carry the
    // cache seeder and the two drills. Any job reachable on push would start
    // accumulating uncancelled runs, so the set is pinned here.
    //
    // Classification is an exact allowlist of the conditions in use, not a
    // substring match: `github.event_name != 'pull_request'` mentions
    // `pull_request` yet IS push-reachable, so matching on the event name alone
    // would silently misclassify it as gated.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'pull_request'",
      "always() && github.event_name == 'pull_request'",
      pullRequestImpactIf,
      docsOnlyIf,
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted'])

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('requires one release-shaped Python runtime target on every pull request', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: pullRequestImpactIf,
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64',
        ci: true,
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('classifies pull-request impact before ordinary CI and keeps docs-only green explicit', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const impact = workflowJob(workflow, 'pr-impact')
    const docsOnly = workflowJob(workflow, 'docs-only')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(impact.steps) || !Array.isArray(aggregate.needs) || !Array.isArray(aggregate.steps)) {
      throw new TypeError('CI impact and aggregate jobs must define steps and dependencies')
    }

    expect(impact).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'pull request / impact',
      outputs: {
        classification: '${{ steps.impact.outputs.classification }}',
        run_ci: '${{ steps.impact.outputs.run_ci }}',
      },
    })
    expect(JSON.stringify(impact.steps)).toContain('node scripts/pr-impact.mjs')
    expect(aggregate.needs).toContain('pr-impact')
    expect(docsOnly).toMatchObject({
      needs: ['pr-impact'],
      name: 'pull request / documentation',
    })
    expect(docsOnly.if).toBe(docsOnlyIf)
    expect(JSON.stringify(docsOnly.steps)).toContain('pnpm run doc-sync')
    expect(aggregate.needs).toContain('docs-only')

    for (const jobName of ['node-24', 'node-24-coverage', 'node-24-consumers', 'node-compat', 'python-sdk', 'python-runtime']) {
      const job = workflowJob(workflow, jobName)
      expect(job.needs, `${jobName} must depend on impact classification`).toEqual(['pr-impact'])
      expect(job.if, `${jobName} must fail open only after a classified full PR`).toBe(pullRequestImpactIf)
    }

    const aggregateText = JSON.stringify(aggregate.steps)
    expect(aggregateText).toContain("needs['pr-impact'].outputs.run_ci == 'false'")
    expect(aggregateText).toContain("needs['docs-only'].result != 'success'")
    expect(aggregateText).toContain("contains(needs.*.result, 'cancelled')")
    expect(aggregateText).toContain("needs['node-24'].result != 'success'")
  })

  it('keeps every Vitest project process-isolated', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })

  it('keeps native HMR watcher suites in the process-bound project', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).toContain("'packages/boot/app-boot/tests/hmr-config.spec.ts'")
    expect(config).toContain("'packages/boot/app-boot/tests/user-patches.spec.ts'")
    expect(config).toContain("'packages/client/ui-primitives/tests/code-block.client.spec.tsx'")
    const processBound = config.slice(config.indexOf('const processBoundTests = ['), config.indexOf('export default defineConfig'))
    expect(processBound).toContain("'packages/boot/app-boot/tests/hmr-config.spec.ts'")
    expect(processBound).toContain("'packages/boot/app-boot/tests/user-patches.spec.ts'")
    expect(processBound).toContain("'packages/client/ui-primitives/tests/code-block.client.spec.tsx'")
  })
})

describe('fork branch CI workflow', () => {
  it('keeps the duplicate fork matrix manual while pull-request CI owns automatic validation', () => {
    const workflow = loadWorkflow('.github/workflows/fork-ci.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const linux = workflowJob(workflow, 'linux-primary')
    const compat = workflowJob(workflow, 'node-compat')
    const pythonSdk = workflowJob(workflow, 'python-sdk')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(linux.steps)
      || !Array.isArray(compat.steps)
      || !Array.isArray(pythonSdk.steps)
      || !Array.isArray(aggregate.needs)) {
      throw new TypeError('fork CI jobs must define executable steps and aggregate dependencies')
    }

    expect(dispatch).toEqual({})
    expect(workflow.on).not.toHaveProperty('push')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(linux['runs-on']).toBe('ubuntu-latest')
    expect(JSON.stringify(linux.steps)).toContain('pnpm run check:ci:linux-primary')
    expect(JSON.stringify(compat.steps)).toContain('pnpm run check:node-compat')
    expect(JSON.stringify(pythonSdk.steps)).toContain('python/sdk pytest')
    expect(pythonRuntime).toMatchObject({
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: { targets: 'node24-linux-x64', ci: true },
    })
    expect(workflow.jobs).not.toHaveProperty('windows')
    expect(JSON.stringify(workflow.jobs)).not.toMatch(/windows|wine|pwsh/iu)
    expect(aggregate).toMatchObject({
      name: 'all checks passed',
      if: 'always()',
    })
    expect(aggregate.needs).toEqual([
      'linux-primary',
      'node-compat',
      'python-sdk',
      'python-runtime',
    ])
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    expect(JSON.stringify(pythonCompat.steps)).toContain('deepseek-harness-sdk==${{ steps.compatibility-version.outputs.version }}')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    expect(JSON.stringify(workflow)).toContain('macosx_14_0_arm64')
    if (!isRecord(manylinuxAddon) || typeof manylinuxAddon.run !== 'string') {
      throw new TypeError('Linux node-pty rebuild must define a shell script')
    }
    const manylinuxAddonRun = manylinuxAddon.run
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(manylinuxAddonRun).toContain('npm_config_build_from_source=true pnpm --dir "$addon_dir" run install')
    expect(manylinuxAddonRun.indexOf('pnpm --dir "$addon_dir" run install')).toBeLessThan(
      manylinuxAddonRun.indexOf('make -C build'),
    )
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Issue lifecycle workflow', () => {
  it('uses explicit review handoff events without rerunning when a draft becomes ready', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyPullRequest = workflowEvent(policy, 'pull_request')

    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecycleJob.if).toBe(
      "${{ github.event_name != 'pull_request_review' || (github.event.action == 'submitted' && github.event.review.state == 'changes_requested') }}",
    )
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({
        exclude: [
          '.agents/notes/archived/**',
          'products/desktop/**',
          'plugins/managed/**',
        ],
      })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
