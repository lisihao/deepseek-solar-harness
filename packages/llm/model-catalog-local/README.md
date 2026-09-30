# @deepseek-ai/dsh-model-catalog-local

English | [中文](README.zh.md)

Local SQLite catalog service for account-observed model menus. It owns `ctx.modelCatalogs` and stores discovery results without credentials, prompts, or model requests.

## Service

- `register(source)` adds one active source and returns its disposer. Each source owns one existing DSH dispatch provider, and every returned model must name that provider.
- `list()` reads persisted snapshots for active sources only. It never calls a source; source disposal removes the source from this read even though its durable rows remain.
- `refresh(sourceIds?)` refreshes every active source or the named subset. Calls for the same source coalesce, receive an abort signal and the configured deadline, and return each source's ready, unavailable, or error snapshot independently.

## Configuration

- `databasePath` is required. Use `:memory:` for a process-local test database or a filesystem path for a durable catalog.
- `refreshTimeoutMs` defaults to 15,000 ms. A source that ignores cancellation cannot write after its refresh race settles or its registration is disposed.

## Persistence and refresh

Successful source results are one SQLite transaction. The current snapshot keeps the upstream `models` order in `model_order`; retained ids missing from that result follow it. An explicit unavailable result records its diagnostic in `snapshot.error` and marks retained models unavailable. A thrown result records the source error, changes retained models to `unknown`, and keeps the previous `lastSuccessAt`. Only schema version 1 with this package's SQLite identity opens.

## Model Experience

### Catalog records

#### What the model sees

Nothing. `ctx.modelCatalogs` stores host-side selector metadata and does not add prompt text, tools, schemas, or messages.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None. Catalog reads and refreshes do not change a model-request prefix.

## Known Limitations and Deferred Work

- **No refresh scheduler** — a consumer chooses when to call `refresh()`; this package never polls an account on its own.
- **No schema migration** — newer or invalid catalog media rejects at open instead of being changed in place.
