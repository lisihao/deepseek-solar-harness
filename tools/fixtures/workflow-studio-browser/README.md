# Workflow Studio browser fixture

Build a static local page with:

```sh
node tools/fixtures/workflow-studio-browser/build.mjs
```

The command writes `index.html`, `workflow-studio-fixture.js`, and its source map to
`/private/tmp/dsh-workflow-studio-fixture`. It starts no server.

The page renders the actual `WorkflowStudioPanel` and `SessionModeControl` against an
in-memory fake `StudioUiApi`. It has Insight and Native source flows, source execution
statuses, CAS draft saving, a delayed completion after an explicit run, and fixture-only
counter access at `window.__dshWorkflowStudioFixture`.

Open the page with `?empty=1` to render a successful empty overview, without
source flows, drafts or execution records. This exercises the explanatory empty
state and its refresh action without creating a task or model request.

`overview`, source refresh, editing, saving, inspection, and mode selection never increment
`counters.modelStarts`. Only `run()` creates a new fixture model start. An explicit `resume()`
uses the original source/run identity, increments `counters.resumes`, and advances only its
remaining fixture stages; it never creates a replacement command.

The page also exposes `window.__dshWorkflowStudioFixture.styleContainment()`. Its
`outsideFlowStrokeDefault` value must stay absent for the fixture's panel-external
`.react-flow` sentinel, proving the editor's bundled XYFlow selectors remain contained.
