# Native collaboration entry and acceptance

Scope: address the missing user entry for the already installed native plugins. Collaboration owns a Chinese “智能协同” conversation tab and settings section. Resident remains the only scheduler. No upstream modification, new core, or second database is introduced.

The Host exposes an owner-only `solarNativeControl` Remote service through the published rc.2 Typert protocol. `status` reads tool/provider registration and the Resident list; it never calls a model or model discovery. `inspect` reads an existing graph. `control` forwards pause/resume/cancel with the exact revision and caller-owned command identity. `test` submits one synthetic text-only graph in a plugin-owned check workspace, with no DSH tool bridge; the user must click a clearly labelled quota-consuming button. Initial load and refresh never run a model.

The UI shows registration separately from actual native execution. It presents graph labels, translated states, node results and errors, and prevents uncertain mutation retries. Internal graph/command identities stay in wire/state, not routine labels. A mutation timeout retains the same graph reference for observation; it does not manufacture a new attempt.

Acceptance: keyless Remote ownership/argument/idempotency tests; built scratch Host registration and status; full native source gate once at the stable boundary; installed app entry at normal/narrow widths, real read-only status, and manual native canaries only with explicit quota approval. A loaded plugin is not an execution pass.
