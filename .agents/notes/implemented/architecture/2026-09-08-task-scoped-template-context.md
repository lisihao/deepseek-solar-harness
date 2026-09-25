# Agent Note: Task-scoped template context

Status: implemented

English | [中文](2026-09-08-task-scoped-template-context.zh.md)

## Problem

A conversation can contain unrelated tasks, and execution can move between native models and physical operators. Treating conversation history as the template selection context risks carrying an earlier task's instructions into a new task. Repeatedly injecting the same template also increases context size without establishing which version actually influenced execution.

## Decision

Template selection belongs to a logical task: the originating request of the currently open Agent turn. A new turn selects again. The selection receipt is logged and attached to the injected message source; the model-visible payload pins the selected id, version, digest, and rendered content. Retained context is reused; if compaction shadows it during the same open turn, the exact pinned content is restored at most once using the recorded receipt. A follow-up after that turn ends does not restore the earlier task's selection. Inherited parent context does not suppress a delegated task's own selection.

Physical-operator propagation carries the model-visible task context in the existing OperatorContextEnvelope. Each Consumer returns its separate digest-bound context receipt, and Resident request identity includes NativeContext. Validation of that separate receipt detects dropped or changed context. This decision changes context preparation, not ownership of provider credentials or execution permissions.

## Alternatives considered

**Conversation-wide template reuse.** This conflates task identity with the containing conversation and cannot safely distinguish unrelated follow-up requests.

**Reinjection on every request.** Repetition increases context size and does not replace explicit version attribution or compaction restoration.

## Consequences

Execution consumers must preserve task identity and the distinction between selection and materialization receipts. A receipt supports attribution; it does not establish response quality or grant additional tools, file access, or external-write permissions. Personal template and preference contents remain private runtime data rather than distributable fixtures.
