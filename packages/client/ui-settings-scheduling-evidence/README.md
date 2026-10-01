# @deepseek-ai/dsh-client-ui-settings-scheduling-evidence

English | [中文](README.zh.md)

Read-only **Scheduling evidence** page in Settings. It asks the authenticated `/scheduling-evidence` RPC channel for one overview on each visit and on **Refresh**, and shows three cards and a table:

- **Your switches:** whether Radar evidence is on, whether personal-use collection is consented, the allocator's evidence mode, the Python interpreter in force, and the cycle interval.
- **Stored data:** the collector's freshness state, when the data was collected and last updated at the source, its age, the generation id, whether the allocator holds that generation, and the row count of each SQLite table.
- **Last cycle:** when it started, whether the collection was skipped, succeeded, or failed, whether the store was read back, and the first failure's message.
- **Model results:** every stored model row with pass rate, task count, IQ, average cost, and average time. By default only the Codex rows the allocator can use are listed; a checkbox shows the rest, and a text box filters by provider, model, or effort.

When Radar is off, the page also shows the settings lines that turn it on. The page changes nothing: the switches live in the settings document, which **Open configuration file** in General settings opens.

## Model Experience

None, as this package only visualizes a Host-owned store in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No switches on the page:** turning Radar or personal-use collection on or off is a settings-document edit; a form row is deferred.
- **One reading per visit:** the page does not subscribe to the store, so a cycle that finishes while it is open shows on the next Refresh.
- **Whole-table transfer:** every stored model row is sent and filtered in the browser, without pagination.
