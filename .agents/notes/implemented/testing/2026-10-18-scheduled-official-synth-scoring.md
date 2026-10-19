# Agent Note: Scheduled official synth scoring

Status: implemented

English | [中文](2026-10-18-scheduled-official-synth-scoring.zh.md)

## Problem

Formula-level grading of an extracted answer cannot reproduce the official OOLONG synth parser's first-gold, formatting and confidence behavior. An otherwise correct scorer can also grade the wrong frozen question if raw outputs and schedule identities are not checked together.

## Decision

The controller adapter validates the reviewed source files, frozen input files and schedule before calling the existing pinned official functions. The original answer string and complete model output reach those functions unchanged. Each output is bound to a scheduled trial, case and input hash. The report retains official content credit separately from completion-aware credit, and lists missing trials without manufacturing their results.

## Alternatives considered

The generic extracted-answer scorer remains useful for formula diagnostics but cannot supply the official primary score. Copying parser behavior into the adapter would create a second implementation that can drift. The adapter delegates to the fingerprinted original functions instead.

## Consequences

Controller reports retain gold and full outputs and must remain outside runner access. File separation does not establish operating-system isolation. The adapter does not settle usage, execute trials, authorize paid work or certify OOLONG-Pairs parity. Focused keyless checks cover direct original-function parity, file and input drift, incomplete lifecycle credit, missing results, invalid identities and refusal before report creation.
