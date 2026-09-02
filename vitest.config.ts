import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './scripts/coverage-exempt.ts'

// Prints exact `path:line:col` records for every uncovered statement, branch
// path, and function when a file misses the per-file 100% gate — the built-in
// threshold ERRORs name only the file. Absolute path because istanbul-reports
// require()s custom reporters (which is also why the reporter is CJS).
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))

// Resolution facade shared by every plugin instance below: tsconfig.base.json
// has no include, which vite-tsconfig-paths treats as match-all, so its paths
// map applies to every test file. paths must win over package exports so built
// lib/ never loads a second module-singleton copy.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> => tsconfigPaths({ projects: ['./tsconfig.base.json'] })

// Windows compatibility packages and their host-specific acceptance suites
// remain in the repository as dormant source, but the supported default
// build/test/coverage path is macOS/Linux and must not select them.
const unsupportedWindowsTests = [
  'packages/fs/fs-local/tests/win32.spec.ts',
  'packages/host/directory-picker-native/tests/built-worker.e2e.ts',
  'packages/host/directory-picker-native/tests/win32-dialog.spec.ts',
  'packages/host/directory-picker-native/tests/win32-dialog-*.spec.ts',
  'packages/session/session-persistence-jsonl/tests/win32.spec.ts',
  'packages/sandbox/sandbox-windows-acl/tests/**/*.spec.ts',
  'packages/sandbox/sandbox-local/tests/acl-grants.spec.ts',
  'packages/shell/pwsh-local/tests/**/*.spec.ts',
  'packages/shell/pwsh-sandbox/tests/**/*.spec.ts',
  'packages/shell/tool-pwsh/tests/**/*.spec.ts',
  'packages/util/atomic-write/tests/windows-contention.spec.ts',
]

const unsupportedWindowsCoverageSources = [
  'packages/fs/fs-local/src/win32.ts',
  'packages/host/directory-picker-native/src/win32-*.ts',
  'packages/session/session-persistence-jsonl/src/win32.ts',
  'packages/sandbox/sandbox-windows-acl/src/**/*.ts',
  'packages/shell/pwsh-local/src/**/*.ts',
  'packages/shell/pwsh-sandbox/src/**/*.ts',
  'packages/shell/tool-pwsh/src/**/*.ts',
]

const testIncludes = [
  'packages/*/*/tests/**/*.spec.{ts,tsx}',
  'apps/*/tests/**/*.spec.ts',
  'examples/*/tests/**/*.spec.ts',
  'scripts/**/*.spec.ts',
]

// The instrumented coverage gate sets this env; the exempt heavy suites then
// run beside it uninstrumented (membership contract in scripts/coverage-exempt.ts).
// A set-but-not-'1' value is a misconfiguration, not a silent no-op.
const coverageExemptRaw = process.env[COVERAGE_EXEMPT_ENV]
if (coverageExemptRaw !== undefined && coverageExemptRaw !== '' && coverageExemptRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_EXEMPT_ENV} must be '1' or unset, got ${JSON.stringify(coverageExemptRaw)}.`)
}
const coverageExemptExcludes = coverageExemptRaw === '1'
  ? coverageExemptHeavySuites.map(suite => suite.exclude)
  : []

// These suites exercise process-global state, process APIs, or timing-sensitive process I/O
// that worker threads cannot isolate reliably under aggregate gate contention.
// Keep the narrow exception in forks while the rest of the inventory avoids per-file processes.
const processBoundTests = [
  'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts',
  'packages/subagent/subagent-acp/tests/subagent-acp.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
  'packages/context/time-context/tests/time-context.spec.ts',
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
  'packages/boot/app-boot/tests/app-boot.spec.ts',
  'packages/boot/app-boot/tests/hmr-config.spec.ts',
  'packages/boot/app-boot/tests/user-patches.spec.ts',
  // Loading every lazy Shiki grammar is CPU-bound and has a real 5s
  // responsiveness contract. Keep it off the shared fork pool so a small CI
  // runner cannot spend that contract competing with aggregate build gates.
  'packages/client/ui-primitives/tests/code-block.client.spec.tsx',
  'packages/workflow/workflow-worker-thread/tests/session.spec.ts',
]

export default defineConfig({
  plugins: [pathsPlugin(), standardDecoratorPlugin()],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    // .tsx: client component specs (jsdom via per-file @vitest-environment pragma).
    include: testIncludes,
    exclude: unsupportedWindowsTests,
    // One coverage invocation aggregates both projects. Every suite forks for
    // Node stability; process-bound suites stay separate for inventory control.
    projects: [
      {
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
        test: {
          name: 'thread-safe',
          // The process-bound project runs beside this one. Two plus its one
          // worker leaves one standard-runner CPU for fixture subprocesses.
          maxWorkers: 2,
          execArgv: vitestExecArgv,
          // Node 24 has aborted in its CJS lexer (v8::ToLocalChecked Empty
          // MaybeLocal in cjs_lexer::Parse) from worker threads on macOS,
          // Linux, and Windows. Forked workers avoid that shared thread path.
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          include: testIncludes,
          exclude: [
            ...unsupportedWindowsTests,
            ...processBoundTests,
            ...coverageExemptExcludes,
          ],
        },
      },
      {
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
        test: {
          name: 'process-bound',
          maxWorkers: 1,
          execArgv: vitestExecArgv,
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          include: processBoundTests,
          exclude: [
            ...unsupportedWindowsTests,
            ...coverageExemptExcludes,
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and examples/ are out of scope (examples are
      // exercised by the demo smoke test instead).
      // .tsx: client components are gated like everything else (jsdom lane).
      include: ['packages/*/*/src/**/*.{ts,tsx}'],
      // Types-only files have no runtime coverage. Importing self-executing bins/workers would boot
      // them inside the unit process, so real subprocess/Worker tests cover their thin entry glue.
      exclude: [
        'packages/*/*/src/types.ts',
        'packages/*/*/src/bin.ts',
        'packages/*/*/src/worker.ts',
        // Dynamic Host/Client composition is covered by its focused lifecycle
        // tests and assembled application checks rather than per-file coverage.
        'packages/self-modification/*/src/**/*.{ts,tsx}',
        // A killed executable lint-contract test can leave a non-product source probe behind.
        'packages/*/*/src/oxlint-contract-*.ts',
        // Client/web UI files whose remaining branches need a browser-grade
        // harness the jsdom lane doesn't cover yet. TODO(gui): cover and
        // remove as the client test lane matures.
        'packages/client/ui-trajectory/src/*',
        // Trajectory's compact Markdown projection retains deferred branch coverage.
        'packages/client/ui-primitives/src/markdown/plain-text.ts',
        'packages/client/ui-user-questions/src/client/QuestionComposer.tsx',
        'packages/client/ui-primitives/src/Menu.tsx',
        'packages/client/ui-primitives/src/RiskConfirmation.tsx',
        'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx',
        'packages/client/ui-workspace/src/client/WorkspacePicker.tsx',
        'packages/client/web-react/src/*',
        // Remote Modules keeps its pure wire/configuration, draft-validation,
        // and store state machines under the per-file gate. The relay's
        // WebSocket/failure tails and React/browser assembly instead retain
        // focused behavior tests while joining the explicit browser/network
        // debt list until those lanes can instrument real sockets and layout.
        'packages/client/ui-remote-modules/src/relay.ts',
        'packages/client/ui-remote-modules/src/client/index.ts',
        'packages/client/ui-remote-modules/src/client/RemoteModuleEntry.tsx',
        'packages/client/ui-remote-modules/src/client/RemoteModulesSettings.tsx',
        // This isolated settings-scope lifecycle has complete unit coverage;
        // keep it out of the broader client-runtime GUI debt exemption.
        'packages/client/runtime/src/**/!(settings-scope).ts',
        // Keep the browser conversation tree under its existing GUI debt
        // exemption while gating the newly stateful Host half and vocabulary.
        'packages/client/ui-conversation/src/client/*',
        'packages/client/ui-conversation/src/invariant.ts',
        'packages/client/ui-primitives/src/DisclosureRow.tsx',
        'packages/client/ui-tool/src/*',
        'packages/client/ui-slots/src/*',
        'packages/client/ui-layout/src/*',
        'packages/client/web/src/*',
        'packages/host/webserver/src/*',
        'packages/client/modules/src/client/system.ts',
        'packages/client/hmr/src/client/index.ts',
        // Web config-tree boot round: the new host-side web-transport halves
        // whose remaining branches need real-composition/process harnesses.
        // TODO(gui): cover and remove with the client test lane above.
        'packages/client/modules/src/index.ts',
        'packages/client/modules/src/invariant.ts',
        'packages/client/modules/src/client/index.ts',
        'packages/client/modules/src/client/manifest.ts',
        'packages/client/hmr/src/index.ts',
        'packages/client/hmr/src/invariant.ts',
        'packages/client/connection/src/index.ts',
        'packages/client/connection/src/http-bridge.ts',
        // This assembly imports generated Host-for-Client code that exists
        // only in lib; the post-build built-bin smoke executes both entries.
        'packages/api/remotes/src/index.ts',
        'packages/api/remotes/src/client/index.ts',
        // Slash/command/input round: per-file gaps deferred with the same
        // client-lane debt. TODO(gui): cover and remove with the lane above.
        'packages/client/connection/src/client/fixture.ts',
        'packages/client/ui-commands/src/index.ts',
        'packages/client/ui-skill/src/index.ts',
        'packages/client/ui-input-trigger/src/index.ts',
        'packages/client/ui-subagent/src/index.ts',
        'packages/client/ui-commands/src/client/popup.ts',
        'packages/client/ui-commands/src/client/directory.ts',
        'packages/client/ui-commands/src/client/service.ts',
        'packages/client/ui-commands/src/client/PopupSelectView.tsx',
        'packages/client/ui-model-selection/src/index.ts',
        'packages/client/ui-permission-presets/src/index.ts',
        'packages/client/ui-model-selection/src/client/ModelSelect.tsx',
        'packages/client/ui-model-selection/src/client/directory.ts',
        'packages/client/ui-model-selection/src/client/index.ts',
        'packages/client/ui-model-selection/src/client/service.ts',
        'packages/client/ui-input-trigger/src/client/controller.ts',
        'packages/client/ui-input-trigger/src/client/service.ts',
        'packages/client/ui-input-trigger/src/core/menu.ts',
        'packages/client/ui-input-trigger/src/core/detect.ts',
        'packages/client/ui-sidebar/src/client/index.ts',
        'packages/client/ui-skill/src/client/index.ts',
        'packages/client/ui-workspace/src/client/index.ts',
        'packages/test-support/client-runtime/src/translate.ts',
        'packages/client/ui-primitives/src/JsonTree.tsx',
        'packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx',
        'packages/client/ui-settings-models/src/client/welcome-store.ts',
        'packages/extensions/*/src/**/*.ts',
        'packages/extensions/*/src/**/*.tsx',
        // Typert generator: correctness is pinned by its fixture suites and
        // the byte-for-byte catalog reproduction test; per-file coverage
        // would put whole-workspace compiler analysis under v8
        // instrumentation — the coverage lane's longest tail.
        'packages/typert/generator/src/*.ts',
        'packages/host/apiproxy/src/index.ts',
        'packages/host/apiproxy/src/invariant.ts',
        'packages/host/apiproxy/src/api-proxy.ts',
        // Projection/command round: executor lifecycle branches and the
        // registry's drive tails need the same maturing lanes. TODO(gui):
        // cover and remove with the client test lane above.
        'packages/interaction/commands/src/index.ts',
        'packages/interaction/commands/src/invariant.ts',
        'packages/session/session-projection/src/index.ts',
        // Solar's imported orchestration/resident feature families retain their
        // focused behavior, package, loader, and Desktop integration suites.
        // Their inherited source does not yet satisfy this repository's
        // per-file 100% unit-coverage contract, so keep that migration debt
        // explicit without weakening the threshold for established packages.
        'packages/orchestration/*/src/**/*.{ts,tsx}',
        'packages/physical-operator/*/src/**/*.{ts,tsx}',
        'packages/bundle/orchestrations/src/**/*.{ts,tsx}',
        'packages/bundle/resident-operators/src/**/*.{ts,tsx}',
        'packages/subagent/subagent-codex/src/wire.ts',
        ...unsupportedWindowsCoverageSources,
      ],
      // 100% or it doesn't merge (docs/testing.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 ignore comment must carry a reason — see the quality-gates Agent Note
      // (.agents/notes/implemented/process/2026-06-11-quality-gates.md).
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: process.env.CI
        ? ['text', uncoveredLocationsReporter]
        : ['text', 'html', uncoveredLocationsReporter],
    },
  },
})
