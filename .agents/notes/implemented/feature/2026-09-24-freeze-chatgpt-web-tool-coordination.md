# Agent Note: Freeze ChatGPT Web tool coordination behind a config switch

Status: implemented

English | [中文](2026-09-24-freeze-chatgpt-web-tool-coordination.zh.md)

## Problem

ChatGPT Web tool coordination lets the website model call DSH tools through a ChatGPT Custom MCP connector. It is the most complex ChatGPT Web path (MCP bridge, tool owners, send receipts, handoff) and has never completed an account-backed tool call. The connector reaches DSH from OpenAI's service, so the local endpoint must be exposed through a tunnel. Automating the ChatGPT website is outside OpenAI's supported interfaces. Codex 0.156.1 now offers the GPT-6 models on the same subscription with native, supported tools, which covers the mode's main purpose.

## Decision

`physical-operator-chatgpt-web` gains `coordinatorEnabled`, default `false`. While it is off, a saved coordinator selection reads as direct without being rewritten, selecting coordination or requesting the MCP address fails with `OPERATOR_UNAVAILABLE`, no MCP endpoint starts, and the operator advertises only ephemeral execution. The setup status carries `coordinatorAvailable`, and the Web setup panel hides the coordination heading and guidance, the coordination choice, connector status, MCP verification, and connection setup, leaving only the Web model controls. The code, tests, and assembled fixtures remain; the Web MCP snapshot and the physical-routing Web test set `coordinatorEnabled: true`.

## Alternatives considered

**Delete the mode.** This removes the most code, but the bridge and receipt work would have to be rebuilt if OpenAI offers a supported connector path.

**Keep it available and finish account acceptance.** This keeps the tunnel exposure and the account risk for a capability Codex already provides.

## Consequences

- Owners who selected tool coordination get direct Web questions after upgrading; setting `coordinatorEnabled: true` restores the previous behavior and their saved selection.
- ChatGPT Web remains a bounded direct advisor for website-only models and features.
