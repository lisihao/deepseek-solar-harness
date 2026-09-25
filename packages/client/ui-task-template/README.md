# @deepseek-ai/dsh-client-ui-task-template

English | [中文](README.zh.md)

Settings-page Consumer for the task prompt-template library. It presents the Server-authoritative template catalog, method editor, field-specific match guidance, enablement, revision count, separate personal preference/memory fields, and a rendered saved-template preview through the authenticated `/task-templates` RPC channel.

New templates start disabled, so an incomplete method cannot participate in selection until the user explicitly enables it.

The editor never stores private content in browser storage or source configuration. Switching a Remote Frontend clears the current catalog and editor before reading the selected Server's private DSH home; a response from the previous authority cannot repopulate the page.

One save may issue separate method, enablement, and personalization mutations. The UI adopts each returned authoritative snapshot immediately; if a later mutation fails, committed changes remain visible and the remaining draft stays available for retry.

## Model Experience

### Template management

#### What the model sees

No request content originates from this browser package. Saving changes private template data that `@deepseek-ai/dsh-task-template-context` may inject into a later logical task.

#### Token effect

Loading, editing, saving, and previewing add no direct tokens and make no model call. Saved content affects a later request only when `@deepseek-ai/dsh-task-template-context` selects it.

#### KV Cache effect

These settings operations do not alter an in-flight request prefix. Changing saved content can change the injected prefix of a later task that selects the template.

## Known Limitations and Deferred Work

- Match values use comma-separated text fields rather than a catalog-backed tag picker.
- The page displays revision counts but does not yet compare or restore historical revisions.
- Preview renders the last saved enabled version; new, disabled, or edited drafts must be saved and enabled first.
