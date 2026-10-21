// tools/fixtures/skill-context-app-probe/src/index.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUserMessage as createUserMessage2 } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { Session, SessionId as SessionId2 } from "@deepseek-ai/dsh-session";

// incubator/skill-context/tests/fixtures/request-harness.ts
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import {
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createUserMessage
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as OfficialSkillTool from "@deepseek-ai/dsh-tool-skill";
var CapturingAdapter = class extends LlmAdapter {
  constructor(plan) {
    super();
    this.plan = plan;
  }
  requests = [];
  async *stream(request) {
    this.requests.push(request);
    const response = this.plan.shift();
    if (response === void 0) throw new Error("request-harness fake-model plan is exhausted");
    for (const chunk of typeof response === "function" ? response(request) : response) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
};
function textResponse(text) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } }
  ];
}
function toolCallResponse(call, name2, args) {
  const id = ToolCallId(call);
  const argumentsJson = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id, name: name2, argumentsDelta: argumentsJson },
    { type: "block-end", index: 0, block: { type: "tool-call", id, name: name2, arguments: argumentsJson } },
    { type: "finish", reason: { kind: "tool-calls" } }
  ];
}
async function publishedLoopSupport() {
  const requireFromLoop = createRequire(
    createRequire(import.meta.url).resolve("@deepseek-ai/dsh-agent-loop/package.json")
  );
  const [systemPrompt, projections] = await Promise.all([
    import(requireFromLoop.resolve("@deepseek-ai/dsh-system-prompt")),
    import(requireFromLoop.resolve("@deepseek-ai/dsh-session-projection"))
  ]);
  return {
    SystemPrompt: systemPrompt.default,
    SessionProjectionRegistry: projections.default
  };
}
async function mountRequestHarness(plan) {
  const ctx = new Context();
  const { SystemPrompt, SessionProjectionRegistry } = await publishedLoopSupport();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SkillRegistry);
  ctx.provide("workingDirectory", {
    async ensure(_agent, signal) {
      signal?.throwIfAborted();
      return process.cwd();
    },
    get() {
      return process.cwd();
    }
  });
  await ctx.plugin(OfficialSkillTool, {});
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new CapturingAdapter(plan);
  ctx.llm.registerAdapter(["skill-context-fixture"], adapter);
  const flushes = { count: 0 };
  ctx.on("session/flush", async () => {
    flushes.count += 1;
  });
  const handles = [];
  return {
    ctx,
    adapter,
    flushes,
    handles,
    async cleanup() {
      await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.dispose()));
      await ctx.fiber.dispose();
    }
  };
}
async function createLoopAgent(harness, id, options = {}) {
  const handle = await harness.ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: "skill-context-fixture", model: "fixture-model" },
    ...options.seed === void 0 ? {} : { seed: options.seed },
    ...options.setup === void 0 ? {} : { setup: options.setup }
  });
  harness.handles.push(handle);
  return handle;
}
async function followLoopAgent(agent, text) {
  agent.agent.followup(createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" }
  }));
  await agent.agent.whenIdle();
}

// tools/fixtures/skill-context-app-probe/src/index.ts
var INSTALLED_PLUGIN = "@lisihao/dsh-solar-skill-context";
var MARKER_ENV = "SOLAR_SKILL_CONTEXT_APP_PROBE_MARKER";
var RECEIPT_SEGMENTS = ["solar", "skill-context", "app-keyless-acceptance.json"];
var TIMEOUT_MS = 6e4;
var TARGET_SKILL = "latest-skill-1476";
var TARGET_BODY = "APP_PROBE_LATEST_SKILL_BODY";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function serialiseError(error) {
  if (error instanceof Error) {
    const candidate = error;
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      ...typeof candidate.code === "string" ? { code: candidate.code } : {}
    };
  }
  return { name: "UnknownError", message: String(error) };
}
function hostGet(ctx, key) {
  return ctx.get(key);
}
function verifyHostTools(ctx) {
  const tools = hostGet(ctx, "tools");
  assert(tools !== void 0 && typeof tools.schemas === "function", "APP_PROBE_HOST_TOOLS_UNAVAILABLE: host tools service is unavailable");
  const names = new Set(tools.schemas().map((schema) => schema.name).filter((name2) => typeof name2 === "string"));
  assert(names.has("skill"), "APP_PROBE_HOST_TOOL_MISSING: official skill tool is not registered");
  assert(names.has("solar_skill_search"), "APP_PROBE_HOST_TOOL_MISSING: solar_skill_search is not registered");
  return { tools: ["skill", "solar_skill_search"] };
}
function configuredDshHome(ctx) {
  const config = hostGet(ctx, "hostConfig") ?? hostGet(ctx, "hostconfig");
  if (!isRecord(config)) return void 0;
  if (typeof config.dshHome === "string") return config.dshHome;
  const dsh = config.dsh;
  if (isRecord(dsh) && typeof dsh.home === "string") return dsh.home;
  return void 0;
}
function resolveDshHomePath(ctx) {
  return resolveDshHome(configuredDshHome(ctx));
}
function receiptPath(ctx) {
  const marker = process.env[MARKER_ENV]?.trim();
  if (marker) return { path: marker, destination: "scratch-marker" };
  return { path: join(resolveDshHomePath(ctx), ...RECEIPT_SEGMENTS), destination: "dsh-home" };
}
async function writeReceipt(path, receipt) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}
`, "utf8");
}
function sourceKind(message) {
  return "source" in message && message.source !== void 0 ? message.source.kind : void 0;
}
function messageText(message) {
  return message.content.map((block) => block.type === "text" ? block.text ?? "" : "").join("\n");
}
function catalogEntries(size, revision) {
  return Array.from({ length: size }, (_, index) => ({
    name: `historical-${revision}-skill-${String(index).padStart(4, "0")}`,
    description: `Historical full catalog ${revision} entry ${index}`
  }));
}
function fullCatalogMessage(size, revision) {
  const entries = catalogEntries(size, revision);
  return createUserMessage2({
    content: [{
      type: "text",
      text: [
        "<system-reminder>",
        `Historical catalog ${revision}; this full body must not reach the repaired request.`,
        "<available_skills>",
        ...entries.map((entry) => `- \`${entry.name}\`: ${entry.description}`),
        "</available_skills>",
        "</system-reminder>"
      ].join("\n")
    }],
    source: { kind: "skill-catalog", form: "catalog", entries }
  });
}
function historicalSeed() {
  const session = Session.create(SessionId2("solar-skill-context-app-probe-history"));
  session.append("user/message", createUserMessage2({
    content: [{ type: "text", text: "Historical user message before catalog one." }],
    source: { kind: "user" }
  }), { surfaceOp: "append" });
  session.append("user/message", fullCatalogMessage(1467, "one"), { surfaceOp: "append" });
  session.append("user/message", createUserMessage2({
    content: [{ type: "text", text: "Historical user message between catalog one and two." }],
    source: { kind: "user" }
  }), { surfaceOp: "append" });
  session.append("user/message", fullCatalogMessage(1475, "two"), { surfaceOp: "append" });
  session.append("user/message", createUserMessage2({
    content: [{ type: "text", text: "Historical user message after catalog two." }],
    source: { kind: "user" }
  }), { surfaceOp: "append" });
  session.append("user/message", fullCatalogMessage(1477, "three"), { surfaceOp: "append" });
  return session.snapshotEvents();
}
function registerCurrentSkills(ctx) {
  for (let index = 0; index < 1477; index += 1) {
    const name2 = index === 1476 ? TARGET_SKILL : `current-skill-${String(index).padStart(4, "0")}`;
    ctx.skills.register({
      name: name2,
      description: index === 1476 ? "The latest exact skill that proves the current 1,477-entry catalog remains searchable." : `Current isolated catalog skill ${index}`,
      content: index === 1476 ? TARGET_BODY : `CURRENT_SKILL_BODY_${index}`,
      source: "runtime",
      invocation: { modelInvocable: true, userInvocable: true }
    });
  }
}
function toolResultFor(events, name2) {
  const call = events.find((event) => event.type === "tool/call" && event.data.name === name2);
  if (call?.type !== "tool/call") return void 0;
  const result = events.find((event) => event.type === "tool/result" && event.data.message.toolCallId === call.data.callId);
  return result?.type === "tool/result" ? result : void 0;
}
function resolvedFilePath(resolved) {
  return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}
async function installedRc2DependencyVersions() {
  const packages = [
    "@deepseek-ai/dsh-agent-loop",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-skill",
    "@deepseek-ai/dsh-tool-skill"
  ];
  const versions = {};
  for (const packageName of packages) {
    const manifestPath = resolvedFilePath(import.meta.resolve(`${packageName}/package.json`));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(typeof manifest.version === "string", `APP_PROBE_DEPENDENCY_VERSION_INVALID: ${packageName} has no package version`);
    assert(manifest.version === "0.2.1-rc.2", `APP_PROBE_DEPENDENCY_VERSION_MISMATCH: ${packageName} is ${manifest.version}`);
    versions[packageName] = manifest.version;
  }
  return versions;
}
async function installedSkillContext() {
  const importPath = resolvedFilePath(import.meta.resolve(INSTALLED_PLUGIN));
  const source = await readFile(importPath);
  const plugin = await import(INSTALLED_PLUGIN);
  assert(typeof plugin.apply === "function", "APP_PROBE_INSTALLED_PLUGIN_INVALID: installed skill-context has no apply()");
  assert(typeof plugin.retireHistoricalCatalogs === "function", "APP_PROBE_INSTALLED_PLUGIN_INVALID: installed skill-context has no retireHistoricalCatalogs()");
  assert(typeof plugin.DISCOVERY_NOTICE === "string", "APP_PROBE_INSTALLED_PLUGIN_INVALID: installed skill-context has no discovery notice");
  return {
    plugin,
    evidence: {
      importPath,
      libIndexSha256: createHash("sha256").update(source).digest("hex"),
      rc2Dependencies: await installedRc2DependencyVersions()
    }
  };
}
async function runIsolatedAcceptance(signal) {
  signal.throwIfAborted();
  const harness = await mountRequestHarness([
    toolCallResponse("app-probe-search-latest", "solar_skill_search", { query: TARGET_SKILL, offset: 0 }),
    toolCallResponse("app-probe-load-latest", "skill", { name: TARGET_SKILL }),
    textResponse("Isolated keyless acceptance completed.")
  ]);
  let agent;
  let cancelAgent;
  try {
    registerCurrentSkills(harness.ctx);
    const installed = await installedSkillContext();
    const plugin = installed.plugin;
    signal.throwIfAborted();
    await harness.ctx.plugin(plugin);
    const seed = historicalSeed();
    agent = await createLoopAgent(harness, "solar-skill-context-app-probe", { seed });
    cancelAgent = () => {
      agent?.agent.cancel({ kind: "hook", reason: "skill-context app probe cancelled" }, { keepInbox: true });
    };
    signal.addEventListener("abort", cancelAgent, { once: true });
    await followLoopAgent(agent, "Run only the isolated keyless skill-context acceptance path.");
    signal.throwIfAborted();
    const requests = harness.adapter.requests;
    assert(requests.length === 3, `APP_PROBE_FAKE_PLAN_MISMATCH: expected 3 fake requests, got ${requests.length}`);
    const requestChecks = requests.map((request, index) => {
      const catalogs = request.messages.filter((message) => sourceKind(message) === "skill-catalog");
      const notices = request.messages.filter((message) => sourceKind(message) === "solar-skill-context");
      assert(catalogs.length === 0, `APP_PROBE_CATALOG_VISIBLE: request ${index + 1} retained a full skill catalog`);
      assert(notices.length === 1, `APP_PROBE_NOTICE_COUNT: request ${index + 1} has ${notices.length} discovery notices`);
      const notice = messageText(notices[0]);
      assert(notice === plugin.DISCOVERY_NOTICE, `APP_PROBE_NOTICE_CONTENT: request ${index + 1} has an unexpected discovery notice`);
      assert(Buffer.byteLength(notice, "utf8") < 1024, `APP_PROBE_NOTICE_TOO_LARGE: request ${index + 1} notice exceeds 1,023 bytes`);
      const tools = request.tools?.map((tool) => tool.name) ?? [];
      assert(tools.includes("skill") && tools.includes("solar_skill_search"), `APP_PROBE_TOOL_SURFACE: request ${index + 1} lacks a required tool`);
      return { messageCount: request.messages.length, tools };
    });
    const events = agent.agent.session.snapshotEvents();
    assert(JSON.stringify(events.slice(0, seed.length)) === JSON.stringify(seed), "APP_PROBE_LOG_MUTATED: historical event prefix changed");
    const catalogSeqs = seed.filter((event) => event.type === "user/message" && event.data.source.kind === "skill-catalog").map((event) => event.seq);
    const retirements = events.filter((event) => event.type === "developer/message" && event.data.message.source.kind === "solar-skill-context" && event.data.message.content.length === 0);
    assert(retirements.length === 3, `APP_PROBE_REPLACEMENT_COUNT: expected 3 catalog replacements, got ${retirements.length}`);
    assert(
      JSON.stringify(retirements.map((event) => event.sourceEventSeqs)) === JSON.stringify(catalogSeqs.map((seq) => [seq])),
      "APP_PROBE_REPLACEMENT_SCOPE: a replacement did not cite exactly one historical catalog"
    );
    const searchResult = toolResultFor(events, "solar_skill_search");
    assert(searchResult !== void 0 && searchResult.data.message.isError === false, "APP_PROBE_SEARCH_FAILED: bounded search returned an error");
    const searchValue = JSON.parse(messageText(searchResult.data.message));
    assert(searchValue.matches?.some((match) => match.name === TARGET_SKILL), "APP_PROBE_SEARCH_MISSING_LATEST: bounded search did not find the newest skill");
    assert(searchValue.totalMatches === 1, `APP_PROBE_SEARCH_UNEXPECTED_TOTAL: exact search total is ${String(searchValue.totalMatches)}`);
    const loaded = toolResultFor(events, "skill");
    assert(loaded !== void 0 && loaded.data.message.isError === false, "APP_PROBE_OFFICIAL_SKILL_FAILED: official skill tool returned an error");
    assert(messageText(loaded.data.message).includes(TARGET_BODY), "APP_PROBE_OFFICIAL_SKILL_BODY: official skill tool did not load the latest body");
    return {
      installedPlugin: {
        importPath: installed.evidence.importPath,
        libIndexSha256: installed.evidence.libIndexSha256,
        rc2Dependencies: installed.evidence.rc2Dependencies,
        exports: { apply: true, retireHistoricalCatalogs: true }
      },
      isolatedSkillCount: 1477,
      fakeModelCalls: requests.length,
      requestChecks,
      historicalCatalogsRetired: retirements.length,
      search: { totalMatches: searchValue.totalMatches, latest: TARGET_SKILL },
      officialSkill: TARGET_SKILL,
      isolatedSessionEventCount: events.length,
      flushCount: harness.flushes.count
    };
  } finally {
    if (cancelAgent !== void 0) signal.removeEventListener("abort", cancelAgent);
    await harness.cleanup();
  }
}
async function withDeadline(parent, action) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const operation = Promise.resolve().then(() => action(controller.signal));
  operation.catch(() => void 0);
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`APP_PROBE_TIMEOUT: isolated acceptance exceeded ${TIMEOUT_MS}ms`);
      controller.abort(error);
      reject(error);
    }, TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    parent.removeEventListener("abort", abortFromParent);
  }
}
async function runAndRecord(ctx, lifecycleSignal) {
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  let target;
  let host;
  let checks = {};
  let failure;
  try {
    lifecycleSignal.throwIfAborted();
    host = verifyHostTools(ctx);
    target = receiptPath(ctx);
    checks = await withDeadline(lifecycleSignal, runIsolatedAcceptance);
  } catch (error) {
    failure = serialiseError(error);
    try {
      target ??= receiptPath(ctx);
    } catch (pathError) {
      failure = {
        ...failure,
        message: `${failure.message}; APP_PROBE_RECEIPT_PATH_FAILED: ${serialiseError(pathError).message}`
      };
    }
  }
  const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  let receipt = {
    formatVersion: 1,
    kind: "solar-skill-context-app-keyless-acceptance",
    keyless: true,
    isolated: true,
    userSessionWrites: 0,
    realProviderCalls: 0,
    startedAt,
    finishedAt,
    ...host === void 0 ? {} : { host },
    checks,
    ok: failure === void 0,
    ...failure === void 0 ? {} : { error: failure }
  };
  if (target === void 0) {
    receipt = {
      ...receipt,
      ok: false,
      error: failure ?? { name: "ReceiptPathError", message: "APP_PROBE_RECEIPT_PATH_FAILED: no receipt path is available" }
    };
  } else {
    receipt = { ...receipt, receiptPath: target.path, receiptDestination: target.destination };
    try {
      await writeReceipt(target.path, receipt);
    } catch (error) {
      receipt = {
        ...receipt,
        ok: false,
        error: { name: "ReceiptWriteError", message: `APP_PROBE_RECEIPT_WRITE_FAILED: ${serialiseError(error).message}` }
      };
    }
  }
  process.stdout.write(`${JSON.stringify(receipt)}
`);
}
var name = "solar-skill-context-app-probe";
var inject = ["appReady"];
function apply(ctx) {
  const ready = hostGet(ctx, "appReady");
  if (ready === void 0 || typeof ready.onReady !== "function") {
    throw new Error("APP_PROBE_APP_READY_UNAVAILABLE: appReady service is unavailable");
  }
  let started = false;
  let lifecycle;
  const cancelReady = ready.onReady(() => {
    if (started) return;
    started = true;
    lifecycle = new AbortController();
    void runAndRecord(ctx, lifecycle.signal).catch((error) => {
      process.stdout.write(`${JSON.stringify({
        formatVersion: 1,
        kind: "solar-skill-context-app-keyless-acceptance",
        keyless: true,
        isolated: true,
        userSessionWrites: 0,
        realProviderCalls: 0,
        ok: false,
        error: serialiseError(error)
      })}
`);
    });
  });
  return () => {
    cancelReady();
    lifecycle?.abort(new Error("APP_PROBE_LIFECYCLE_CANCELLED: plugin disposed before acceptance completed"));
  };
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
