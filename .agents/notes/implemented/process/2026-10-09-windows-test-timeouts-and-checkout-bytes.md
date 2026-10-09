# Agent Note: Windows native test timeouts and checkout bytes

Status: implemented

English | [中文](2026-10-09-windows-test-timeouts-and-checkout-bytes.zh.md)

## Problem

The independent [native Windows job](2026-08-08-native-windows-pull-request-ci.md) failed on 22 of the 50 pull-request runs that finished between 2026-10-03 and 2026-10-09 (9 more were cancelled), including runs that changed nothing it exercises. Each failure was a different test, which made it look like noise.

## Evidence

Failing-run logs were classified by failure kind (51 failing test instances):

- **27 timeouts at Vitest's 5 s default**, three more at explicit 15 s or 30 s limits, spread over about twenty files: Git, SQLite, filesystem, and subprocess fixtures. The coverage step took the same time in failing and passing runs (median about 790 s), so the machine was not slower on failure; individual tests crossed the line.
- **10 line-ending assertions**, `'exact commit fixture\r\n'` where the commit holds `\n`. One run predates the earlier snapshot-import fix; the other three are the case below.
- **About 10 temporary-directory races** (`ENOTEMPTY`, `EBUSY`, `ENOENT`) when a test deleted a directory whose file a process had just closed, and one `listen EACCES` on a temporary socket.

## Decision

**Checkout bytes are a product fix.** `materializeWorkspace` created a remote execution checkout with `git clone --shared --no-checkout` and `git checkout --detach`, inheriting the host Git configuration. A Windows host usually has `core.autocrlf=true`, so the member received CRLF files instead of the committed bytes. The snapshot-import path already pinned `core.autocrlf=false`; both clone paths now do before checkout. The test helper that set it afterwards and ran `git reset --hard` is removed: `reset --hard` leaves a file alone when its size and time match the index, so it only repaired the checkout inside Git's racy-timestamp window, which is why the failure came and went. A regression test points `GIT_CONFIG_GLOBAL` at `core.autocrlf=true`, which reproduces on any platform.

**Windows gets a longer default timeout, not per-test patches.** Windows defaults to 20 s tests and 30 s hooks in `vitest.config.ts`; Linux and macOS keep 5 s and 10 s, and an explicit timeout in a test always wins. The runs showed a spread of tests near the line rather than one slow fixture, so another per-test override would have been the same patch again.

**Temporary-directory teardown retries** (`maxRetries`, `retryDelay` on `fs.rm`) in the two specs that failed that way.

## Alternatives considered

**Keep 5 s and fix tests one at a time.** Each earlier fix removed one failing test while the rate stayed near half of the runs.

**Raise the timeout everywhere.** It would hide slowness regressions on the required Linux lane for a Windows problem.

**Make the native job retry failed tests.** A retry hides a flaky test instead of showing it, and the lane's value is its unmasked result.

## Consequences

A hang on Windows is reported after 20 s instead of 5 s, and a test that slows down on Windows no longer fails at 5 s. The new default is not proof that the lane is stable: the measured failure rate before the change is the baseline to compare against, and tests that fail for another reason (the `listen EACCES` socket, one Cordis catalog comparison, one governed-file-tool match) are left for their own investigation.
