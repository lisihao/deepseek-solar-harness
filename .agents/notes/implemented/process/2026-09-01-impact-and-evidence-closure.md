# Agent Note: Separate change impact from Evidence input closure

Status: implemented

English | [中文](2026-09-01-impact-and-evidence-closure.zh.md)

## Problem

The same scope label previously served two different purposes: selecting which governance gate should run and deciding which changed bytes belonged to that gate's reusable Evidence fingerprint. Documentation changes legitimately select `source-build` because `doc-sync` consumes prepared host contracts, but documentation bytes do not change that build. Coupling selection and fingerprint inputs therefore invalidated a passing source-build receipt even when every build input was unchanged.

Ordinary pull-request CI also provisioned all Linux, compatibility, Python, Wine, and native-Windows lanes for an explicit documentation-only path set. The pre-change pull-request baseline consumed an observed 82 minutes 30 seconds of hosted job wall time, or about 92 runner-minutes after per-job rounding. Its required governance verdict arrived after 10 minutes 59 seconds. These numbers are a baseline, not a projected saving.

## Decision

Governance gates may declare `select_when` independently from `input_patterns`. `select_when` controls scheduling; `input_patterns` defines the changed-file closure incorporated into the Evidence fingerprint. Existing profiles that declare only `scopes` retain their prior selection and fingerprint semantics. A profile may migrate one gate at a time, and changing its input selector invalidates earlier Evidence once rather than silently reinterpreting it.

`source-build` and the three dependency-install gates declare explicit source, manifest, lock, configuration, and installer inputs. Their command, executable identity, baseline, dependency fingerprints, and producer Evidence remain part of the reusable contract. Documentation-only changes can therefore reuse an unchanged source-build receipt, while source, manifest, lock, runtime, command, or dependency changes still invalidate it.

Pull-request CI uses the existing conservative path classifier before ordinary heavy jobs. Only the explicit documentation allowlist emits `run_ci=false`; empty input, an unknown path, classifier failure, repository automation, package input, source, or tooling remains full CI. The stable aggregate job always runs. It accepts intentionally skipped heavy jobs only after a successful docs-only classification and continues to reject failures, cancellations, or unexpected skips. Solar pull requests retain their required governance-owned `doc-sync`; documentation-only pull requests to another base run one targeted documentation job. Push and manual benchmark behavior is unchanged.

The changed governance runtime is sealed as `@lisihao/dsh-code-harness-governance@0.3.14`. Because DSH Desktop consumes that immutable tarball, the compatible runtime-only change assigns Desktop patch version `3.10.3`; source, packaged artifact, and installed runtime must converge on that version through D00-D08 before delivery.

## Alternatives considered

**Stop selecting `source-build` for documentation.** Rejected because current documentation contracts consume generated host output; removing the dependency would change correctness rather than remove duplicate work.

**Fingerprint every changed path selected by the gate.** Rejected because selection is intentionally broader than the gate's byte-level dependency closure.

**Use workflow-level `paths-ignore`.** Rejected because it can remove stable check names and provides no explicit classifier verdict for branch protection.

**Cache by commit SHA alone.** Rejected because commit identity neither proves relevant input equivalence after an amend/rebase nor captures runtime, executable, dependency, and profile changes.

## Consequences

- Explicit documentation-only pull requests avoid ordinary heavy CI allocation while retaining visible classifier, documentation-contract, and aggregate verdicts.
- A gate selected for orchestration can reuse Evidence whose declared inputs and complete execution contract are unchanged.
- Legacy profiles remain compatible; migrated gates pay one deliberate Evidence invalidation when the selector contract changes.
- Full governance remains a single late integration gate for a stable change set. Passing focused or cached Evidence is not upgraded into release or deployment authority.
- Savings must be measured on a real post-merge documentation-only pull request; the baseline above does not prove the achieved delta.

## Verification

Focused contracts cover conservative path classification, docs-only aggregate semantics, legacy profile validation, independent gate selection and input closure, documentation-only Evidence reuse, and invalidation by source, manifest, lock, runtime, or dependency changes. Final acceptance requires the repository's strict audit, full Code-as-Harness verification and attestation once the integrated tree is stable, followed by exact-commit remote CI and one documentation-only measurement pull request.
