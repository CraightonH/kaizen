# Core Orchestration Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore end-to-end core orchestration coverage (bootstrap → plugin init → event bus → executor → ui → session loop → teardown) using tiny inline fixture plugins that live at `tests/fixtures/ci-marketplace/`, plus a new test at `src/core/orchestration.test.ts`. Replaces the deleted `scripts/test-core.ts`.

**Architecture:** Four fixture plugins (`fixture-events`, `fixture-executor`, `fixture-ui`, `fixture-lifecycle`) composed into a local marketplace. Each fixture is a `.mjs` file with a `package.json`. A new test file registers the marketplace, installs the fixtures via `bootstrapMissingPlugins`, calls `bootstrap()` with an inline spy plugin injected through the `builtins` parameter, and asserts the spy recorded the expected orchestration events. Fixtures communicate observable state to the spy (and to the test) via the kaizen event bus.

**Tech Stack:** Bun test runner (`bun:test`), kaizen core APIs (`bootstrap`, `initializePluginSystem`, `bootstrapMissingPlugins`, `addMarketplace`), `runInPluginScope` is not used directly — core handles it.

**Issue:** https://github.com/CraightonH/kaizen/issues/12
**Related specs:** `docs/superpowers/specs/2026-04-18-builtin-plugins-repo-decoupling-design.md` (calls for fixture strategy)

---

## File Structure

### New files

- `tests/fixtures/ci-marketplace/.kaizen/marketplace.json` — catalog declaring the four fixture plugins, each at `file` source paths relative to the marketplace root.
- `tests/fixtures/ci-marketplace/plugins/fixture-events/package.json`
- `tests/fixtures/ci-marketplace/plugins/fixture-events/index.mjs` — defines the six canonical session events (same names as real `core-events`).
- `tests/fixtures/ci-marketplace/plugins/fixture-executor/package.json`
- `tests/fixtures/ci-marketplace/plugins/fixture-executor/index.mjs` — registers an `Executor` returning a canned response; emits `test:executor:send` each call.
- `tests/fixtures/ci-marketplace/plugins/fixture-ui/package.json`
- `tests/fixtures/ci-marketplace/plugins/fixture-ui/index.mjs` — registers a `UiProvider` whose `accept()` yields one `UiChannel`; channel's `receive()` returns one scripted message then closes; emits `test:ui:received` and `test:ui:sent`.
- `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/package.json`
- `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs` — provides `core-lifecycle:lifecycle.drive`. `start(ctx)` emits SESSION_START, invokes the executor with one message, drives one UI turn, emits SESSION_END, returns.
- `src/core/orchestration.test.ts` — the test that ties it all together.

### Rationale for persistent fixtures (not inline builtins)

Inline plugins via `builtins: Record<string, KaizenPlugin>` would work but bypass the real install + load path. Keeping the fixtures on disk and registered through a real local marketplace exercises:
- `addMarketplace({ local: true })` symlink path
- `bootstrapMissingPlugins` install flow
- `plugin-installer.ts` file-source resolution
- `plugin-loader.ts` package.json → entry resolution
- Real capability-registry negotiation for `core-lifecycle:lifecycle.drive`

That's the coverage the deleted `test-core.ts` gave us and is the whole point of the issue. The spy plugin passed via `builtins` is a small exception — it exists only to capture events in closures that live in test scope.

---

## Task 1: Events fixture

**Files:**
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-events/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-events/index.mjs`

- [ ] **Step 1: Create the package.json**

Write `tests/fixtures/ci-marketplace/plugins/fixture-events/package.json`:

```json
{
  "name": "fixture-events",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

- [ ] **Step 2: Create the plugin module**

Write `tests/fixtures/ci-marketplace/plugins/fixture-events/index.mjs`:

```javascript
// Minimal fixture mirroring core-events. Pre-defines the six canonical
// session events so fixture-lifecycle and fixture-executor can emit them.
export const EVENTS = {
  SESSION_START:  "session:start",
  SESSION_END:    "session:end",
  USER_MESSAGE:   "session:user_message",
  AGENT_RESPONSE: "session:response",
  TOOL_BEFORE:    "tool:before",
  TOOL_AFTER:     "tool:after",
};

export default {
  name: "fixture-events",
  apiVersion: "2",
  async setup(ctx) {
    for (const name of Object.values(EVENTS)) ctx.defineEvent(name);
    // Also define test-local probes the spy plugin listens on.
    ctx.defineEvent("test:executor:send");
    ctx.defineEvent("test:ui:received");
    ctx.defineEvent("test:ui:sent");
    ctx.defineEvent("test:lifecycle:start");
    ctx.defineEvent("test:lifecycle:end");
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/ci-marketplace/plugins/fixture-events
git commit -m "test(fixtures): add fixture-events plugin"
```

---

## Task 2: Executor fixture

**Files:**
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-executor/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-executor/index.mjs`

- [ ] **Step 1: Create the package.json**

```json
{
  "name": "fixture-executor",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

- [ ] **Step 2: Create the plugin module**

```javascript
// Returns a canned response. Emits test:executor:send on every call so the
// spy plugin can count invocations and capture arguments.
export default {
  name: "fixture-executor",
  apiVersion: "2",
  capabilities: { provides: ["core-lifecycle:executor.send"] },
  async setup(ctx) {
    ctx.registerExecutor({
      async send(messages, tools) {
        await ctx.emit("test:executor:send", {
          messageCount: messages.length,
          toolCount: tools.length,
        });
        return { content: "fixture response", tool_calls: [], stop_reason: "end_turn" };
      },
      async *stream() { yield { type: "done" }; },
    });
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/ci-marketplace/plugins/fixture-executor
git commit -m "test(fixtures): add fixture-executor plugin"
```

---

## Task 3: UI fixture

**Files:**
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-ui/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-ui/index.mjs`

- [ ] **Step 1: Create the package.json**

```json
{
  "name": "fixture-ui",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

- [ ] **Step 2: Create the plugin module**

```javascript
// Scripted single-turn UI. accept() yields one channel; the channel delivers
// one user message via receive() then closes. send() just records.
export default {
  name: "fixture-ui",
  apiVersion: "2",
  capabilities: { provides: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"] },
  async setup(ctx) {
    ctx.registerUi({
      async *accept() {
        let delivered = false;
        let closed = false;
        yield {
          id: "fixture-session",
          async receive() {
            if (delivered || closed) {
              // Mimic EOF — lifecycle loop breaks on null.
              closed = true;
              return null;
            }
            delivered = true;
            await ctx.emit("test:ui:received", { content: "hello fixture" });
            return { type: "text", content: "hello fixture" };
          },
          async send(msg) {
            await ctx.emit("test:ui:sent", { msg });
          },
          async close() { closed = true; },
        };
      },
    });
  },
};
```

**NOTE (for implementer):** the exact contract for `UiChannel.receive()` at end-of-stream may differ — check `src/types/plugin.ts` and `core-ui-terminal`'s behavior at session end. If `receive()` should throw or return a sentinel type other than `null`, adjust. Don't invent a contract; match what core-lifecycle expects in its session loop.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/ci-marketplace/plugins/fixture-ui
git commit -m "test(fixtures): add fixture-ui plugin"
```

---

## Task 4: Lifecycle fixture

**Files:**
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs`

- [ ] **Step 1: Create the package.json**

```json
{
  "name": "fixture-lifecycle",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

- [ ] **Step 2: Create the plugin module**

```javascript
// Minimal lifecycle provider. Drives exactly one session turn, emits
// test:lifecycle:start / :end bracketing the work, then returns so
// bootstrap() resolves.
export default {
  name: "fixture-lifecycle",
  apiVersion: "2",
  capabilities: {
    provides: ["core-lifecycle:lifecycle.drive"],
    consumes: ["core-lifecycle:executor.send", "core-lifecycle:ui.input", "core-lifecycle:ui.output"],
  },
  async setup() {},
  async start(ctx) {
    await ctx.emit("test:lifecycle:start");
    await ctx.emit("session:start");

    const ui = ctx.runtime.ui.getFirst();
    const executor = ctx.runtime.executors.getFirst();

    for await (const channel of ui.accept()) {
      const userMsg = await channel.receive();
      if (!userMsg) break;
      await ctx.emit("session:user_message", userMsg);

      const tools = ctx.runtime.tools.list();
      const response = await executor.send([userMsg], tools);
      await ctx.emit("session:response", response);
      await channel.send({ type: "text", content: response.content });

      await channel.close();
      break;
    }

    await ctx.emit("session:end");
    await ctx.emit("test:lifecycle:end");
  },
};
```

**NOTE (for implementer):** verify every `ctx.runtime.*` call shape against `src/types/plugin.ts`'s `PluginContext.runtime` definition and against `core-lifecycle`'s real implementation in `../kaizen-official-plugins/plugins/core-lifecycle/`. The fixture must use the real API, not a guess.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/ci-marketplace/plugins/fixture-lifecycle
git commit -m "test(fixtures): add fixture-lifecycle plugin"
```

---

## Task 5: Marketplace catalog

**Files:**
- Create: `tests/fixtures/ci-marketplace/.kaizen/marketplace.json`

- [ ] **Step 1: Write the catalog**

```json
{
  "version": "1.0.0",
  "name": "ci-marketplace",
  "url": "local://tests/fixtures/ci-marketplace",
  "entries": [
    {
      "kind": "plugin",
      "name": "fixture-events",
      "description": "Pre-defines canonical session events for core orchestration tests.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/fixture-events" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "fixture-executor",
      "description": "Canned-response executor for core orchestration tests.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/fixture-executor" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "fixture-ui",
      "description": "Scripted single-turn UI for core orchestration tests.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/fixture-ui" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "fixture-lifecycle",
      "description": "Minimal lifecycle provider for core orchestration tests.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/fixture-lifecycle" } }
      ]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/ci-marketplace/.kaizen/marketplace.json
git commit -m "test(fixtures): add ci-marketplace catalog"
```

---

## Task 6: Orchestration test

**Files:**
- Create: `src/core/orchestration.test.ts`

This is the core task. It drives the full system and asserts on every observable.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { bootstrap } from "./index.js";
import { bootstrapMissingPlugins } from "./bootstrap.js";
import type { KaizenPlugin } from "../types/plugin.js";

const FIXTURE_MARKETPLACE = resolve(process.cwd(), "tests", "fixtures", "ci-marketplace");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-orch-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("core orchestration against ci-marketplace fixtures", () => {
  it("boots plugins, runs one session turn, tears down cleanly", async () => {
    const lockfilePath = join(home, "kaizen.permissions.lock");
    await bootstrapMissingPlugins(
      {
        plugins: [
          "ci/fixture-events@1.0.0",
          "ci/fixture-executor@1.0.0",
          "ci/fixture-ui@1.0.0",
          "ci/fixture-lifecycle@1.0.0",
        ],
        marketplaces: [{ id: "ci", url: FIXTURE_MARKETPLACE }],
      },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );

    // Spy plugin: recorded events visible to the test via closure state.
    const observed: string[] = [];
    const payloads: Record<string, unknown[]> = {};
    const EVENTS = [
      "test:lifecycle:start",
      "session:start",
      "session:user_message",
      "test:executor:send",
      "session:response",
      "test:ui:sent",
      "session:end",
      "test:lifecycle:end",
    ];
    const spy: KaizenPlugin = {
      name: "spy",
      apiVersion: "2",
      capabilities: { consumes: [] },
      async setup(ctx) {
        for (const name of EVENTS) {
          ctx.on(name, async (payload) => {
            observed.push(name);
            (payloads[name] ??= []).push(payload);
          });
        }
      },
    };

    await bootstrap(
      {
        plugins: [
          "ci/fixture-events@1.0.0",
          "ci/fixture-executor@1.0.0",
          "ci/fixture-ui@1.0.0",
          "ci/fixture-lifecycle@1.0.0",
        ],
        marketplaces: [{ id: "ci", url: FIXTURE_MARKETPLACE }],
      },
      { spy },
    );

    // Ordering: lifecycle bracket envelops session bracket.
    expect(observed).toEqual([
      "test:lifecycle:start",
      "session:start",
      "session:user_message",
      "test:executor:send",
      "session:response",
      "test:ui:sent",
      "session:end",
      "test:lifecycle:end",
    ]);
    expect(payloads["test:executor:send"]?.[0]).toMatchObject({ messageCount: 1 });
    expect(payloads["session:response"]?.[0]).toMatchObject({ content: "fixture response" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test src/core/orchestration.test.ts`

Expected: failure. Exact shape of the first failure depends on which fixture contract is off first; common possibilities:
- "no plugin provides core-lifecycle:lifecycle.drive" (capability miswired)
- a runtime TypeError calling `ctx.runtime.ui.getFirst()` if the API differs from what the fixture assumes
- event ordering mismatch if fixture-lifecycle emits in a different order than the spy expects

Capture the failure output; use it to drive fixture corrections in Step 3.

- [ ] **Step 3: Iterate to green**

Adjust the fixtures (Tasks 1–4 files) until the test passes. When iterating:
- Do not loosen the assertion (`expect(observed).toEqual([...])`) to match whatever fixtures happen to do. Fix the fixtures to match the assertion — the assertion is the spec of what "correct orchestration" means.
- The only exception: if the real API (per `src/types/plugin.ts` + the real `core-lifecycle` plugin) contradicts the assertion (e.g. core actually emits a different event name or ordering), update the assertion to match reality and leave a comment explaining why.

- [ ] **Step 4: Commit the test**

```bash
git add src/core/orchestration.test.ts
git commit -m "test(core): orchestration smoke against ci-marketplace fixtures"
```

If fixture files changed during iteration, amend each fixture commit or add follow-up fix commits as appropriate — prefer follow-up commits to keep history linear.

---

## Task 7: Sanity run of full suite + typecheck

- [ ] **Step 1: Run the full test suite**

```bash
bun test
```

Expected: all tests pass, including the new `orchestration.test.ts` and all pre-existing tests. If any pre-existing test regresses, stop and investigate — the fixtures are not supposed to leak state between tests, but check `beforeEach`/`afterEach` teardown.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: clean. `src/core/orchestration.test.ts` is the only new TS file; fixtures are `.mjs` and excluded from typecheck by being under `tests/` (outside `src/**/*` and `plugins/**/*` in `tsconfig.json` `include`).

- [ ] **Step 3: No additional commit**

Nothing to commit — this task is verification only.

---

## Task 8: Open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/core-orchestration-fixtures
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "Core orchestration test via ci-marketplace fixtures (closes #12)" --body "$(cat <<'EOF'
## Summary

Replaces the deleted \`scripts/test-core.ts\` with inline-fixture bootstrap coverage per #12:

- \`tests/fixtures/ci-marketplace/\` — four fixture plugins (events, executor, ui, lifecycle) in a local marketplace, not shipped.
- \`src/core/orchestration.test.ts\` — drives full \`bootstrap()\` flow, installs fixtures via the real marketplace install path, asserts event ordering through an inline spy plugin.

Kaizen core now has zero dependency on the sibling \`kaizen-official-plugins\` checkout for its own test suite.

## Test Plan

- [x] \`bun test src/core/orchestration.test.ts\` passes locally.
- [x] \`bun test\` whole suite green.
- [x] \`bun run typecheck\` clean.
- [ ] CI passes on PR.

Closes #12.
EOF
)"
```

---

## Risks / Unknowns

1. **UI channel end-of-stream signal.** Task 3 guesses that `UiChannel.receive()` returning `null` is treated as EOF by a real lifecycle loop. If core-lifecycle actually expects a specific sentinel (throw `EOFError`, return `{ type: "end" }`, etc.), the fixture-ui and fixture-lifecycle must match. Verify before finalizing Task 3/4.
2. **Capability strings.** The `provides: ["core-lifecycle:lifecycle.drive"]` et al. come from the Explore findings on the real plugin. If those strings change (e.g. the capability registry is versioned), update the fixtures to match the version used by core at the time of implementation.
3. **Event bus emit semantics under `bootstrap`.** `ctx.emit` in a plugin's `start()` is synchronous-over-promises; the spy captures events serially in registration order. If bootstrap runs spy `setup()` AFTER fixture-events `setup()` (required so spy can subscribe to fixture-defined events), that's fine — but if topological order puts spy first, it must still be able to subscribe to events defined later. Test behavior; if ordering bites, adjust spy to declare `consumes: ["fixture-events"]` or similar.
4. **KAIZEN_HOME_OVERRIDE scope.** Existing tests use this env var; it's assumed to be honored by `kaizen-config.ts`. No change needed but confirm during Step 1 of Task 6.
