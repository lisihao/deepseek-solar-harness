# @deepseek-ai/dsh-client-ui-task-template

English | [中文](README.zh.md)

Settings-page Consumer for the task prompt-template library. It presents the Server-authoritative template catalog, method editor, match attributes, enablement, revision count, and separate personal preference/memory fields through the authenticated `/task-templates` RPC channel.

The editor never stores private content in browser storage or source configuration. Switching a Remote Frontend changes the authority reached by the connection, so edits apply to that selected Server's private DSH home.

## Model Experience

This UI makes no model call. Saved templates become model-visible only when an execution Consumer selects them for a later logical task.

#### Token and KV Cache effect

None while browsing or editing.

## Known Limitations and Deferred Work

- Match values use comma-separated text fields rather than a catalog-backed tag picker.
- The page displays revision counts but does not yet compare or restore historical revisions.
