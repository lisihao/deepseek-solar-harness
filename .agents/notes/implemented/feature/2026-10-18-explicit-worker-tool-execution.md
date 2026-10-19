# Agent Note: Explicit worker tool execution

Status: implemented

English | [中文](2026-10-18-explicit-worker-tool-execution.zh.md)

## Problem

CodeAct comparison Consumers need the same actual tool loop and physical-request admission as RLM without claiming an enabled RLM plan. Previously, only that plan selected the DeepSeek worker tool loop.

## Decision

The model-worker Definition carries optional explicit toolExecution and the Provider capability supportsToolExecution. Unsupported Providers are refused before execution. DeepSeek gives the explicit limit precedence, derives the previous limit only when it is absent and an RLM plan is enabled, and otherwise retains ordinary single-request generation. Missing or incompatible bridges fail before the first model request. Both tool paths share generateWithTools, collectResponse and evaluationOptions.

The maxToolRounds count bounds tool-execution rounds, not physical attempts. N rounds can require N+1 model requests; the last response cannot execute another tool. The original request admission, physical observer, missing usage and terminal result remain authoritative. The worker does not restart a command after a refusal, cancellation or unknown outcome. The [Provider README](../../../../packages/orchestration/model-worker-deepseek/README.md) owns the request contract.

## Alternatives considered

Enabling an RLM plan for CodeAct would conflate a comparison's tool capability with RLM selection. A second tool loop would duplicate the execution and accounting paths the comparison must share.

## Consequences

This internal seam permits a fake-adapter comparison through the actual Worker and IPC bridge. Equal-prompt checks compare model-visible message fields, tools, generation parameters, admissions and bridge requests; generated message identity and time fields are excluded. This does not establish context externalization, independent spawn policies, complete tree budgets, a faithful paper reproduction or measured benefit. The assembled offline Consumer and Loader transcript remain separate integration work; no paid experiment or installation is included.
