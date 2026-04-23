# Ecosystem Design Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `docs/guides/ecosystem-design.md` and patch three existing docs to remove stale `core-events` references and surface the vocabulary-as-service pattern.

**Architecture:** Pure documentation change. One new file; three targeted edits to existing reference/guide docs. No code changes.

**Tech Stack:** Markdown. Verified by reading the rendered content for internal consistency.

**Spec:** `docs/superpowers/specs/2026-04-22-ecosystem-design-guide-design.md`

---

## File Map

| Action | Path | What changes |
|--------|------|-------------|
| Create | `docs/guides/ecosystem-design.md` | New guide: philosophy, roles, init-order principle, workflow examples |
| Modify | `docs/reference/plugin-api.md:320–346` | Replace stale `core-events` prose + import snippet + event table with generic vocabulary-as-service explanation |
| Modify | `docs/reference/plugin-standards.md:262` | Add `[guideline]` about consuming vocabulary service when `defineEvent` lives in another plugin |
| Modify | `docs/guides/plugin-authoring.md:261` | Add note after the stub paragraph about vocabulary service wiring in real harnesses |

---

## Task 1: Create `docs/guides/ecosystem-design.md`

**Files:**
- Create: `docs/guides/ecosystem-design.md`

- [ ] **Step 1: Write the file**

Create `docs/guides/ecosystem-design.md` with the following content:

```markdown
# Ecosystem Design

*Read when: you are designing a set of plugins that work together as a harness, or you want to understand why kaizen's plugin model is structured the way it is.*

## Philosophy

> Code for what's deterministic. LLMs for what isn't.

LLMs are good at reading context and producing structured intent. Plugins are good at executing that intent against real systems. The job of a plugin ecosystem is to draw that line explicitly.

An LLM deciding to open a pull request is a judgement call — non-deterministic, context-dependent. The actual GitHub API call is deterministic: given a title, body, and branch, the outcome is predictable. A well-designed ecosystem has the LLM output structured data and a dedicated plugin execute the git ops. No LLM is involved in the operation itself. This keeps each part auditable, testable, and replaceable independently.

The same principle applies everywhere: shell commands, database writes, file edits, API calls. If you can write a deterministic function that does it, a plugin should own it — not the LLM.

## Ecosystem roles

These are descriptions of what plugins tend to do, not types kaizen enforces. The only constraint kaizen places on your ecosystem is that exactly one plugin declares `driver: true`. Everything else is a choice.

### Vocabulary plugin (optional, strongly recommended)

A plugin whose `setup()` calls `ctx.defineEvent` for every event name the ecosystem uses, then exposes those names as a service.

```ts
// events/index.ts
export const VOCAB = Object.freeze({
  SESSION_START: "session:start",
  SESSION_END:   "session:end",
  INPUT_RECEIVED: "input:received",
} as const);

export type Vocab = typeof VOCAB;

const plugin: KaizenPlugin = {
  name: "events",
  apiVersion: "2.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["events:vocabulary"] },

  async setup(ctx) {
    ctx.defineService("events:vocabulary", { description: "canonical event names" });
    ctx.provideService<Vocab>("events:vocabulary", VOCAB);
    for (const name of Object.values(VOCAB)) ctx.defineEvent(name);
  },
};
```

Other plugins that emit these events declare `consumes: ["events:vocabulary"]`. That declaration gives the topo-sort an edge, guaranteeing the vocabulary plugin initializes before any emitter. Without that edge, init order is not deterministic and emitters may run before `defineEvent` is called — producing a silent warning and a potentially missed event.

See [Init order and the vocabulary pattern](#init-order-and-the-vocabulary-pattern) for a full explanation.

This is a convention, not a requirement. A driver plugin could define its own events inline. A small harness with one emitter may not need a dedicated vocabulary plugin at all. The pattern pays off when more than one plugin shares an event bus.

### Driver (required, exactly one)

The plugin with `driver: true`. Owns the session loop. Declares what services it needs; the ecosystem fills that contract. Nothing about the contract is prescribed by kaizen — the driver author decides what the session requires.

```ts
const plugin: KaizenPlugin = {
  name: "driver",
  apiVersion: "2.0.0",
  driver: true,
  permissions: { tier: "trusted" },
  services: { consumes: ["events:vocabulary", "shell:exec"] },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    ctx.consumeService("shell:exec");
  },

  async start(ctx) {
    const V = ctx.useService<Vocab>("events:vocabulary");
    const shell = ctx.useService<ShellExec>("shell:exec");
    await ctx.emit(V.SESSION_START);
    // ... session loop
    await ctx.emit(V.SESSION_END);
  },
};
```

### Everything else

Service providers and event subscribers. Could be a terminal interface, a web server, an LLM wrapper, a GitHub client, a database adapter, a pre-execution gate. No prescribed names, no cardinality limits beyond the one-provider-per-service rule (two plugins providing the same service name is a fatal startup error — give them distinct names: `openai:llm`, `anthropic:llm`).

A driver that wants to fan out to multiple providers uses the event bus — that is what it exists for.

## Init order and the vocabulary pattern

kaizen's topo-sort is built solely from `services.consumes` / `services.provides` edges. A plugin that only calls `ctx.defineEvent` in `setup()` has no services edge, so its position in the init order is not pinned relative to other plugins.

`ctx.emit()` on an event name that was never passed to `ctx.defineEvent` emits a warning but does not throw. Failures are silent.

The fix is to expose the vocabulary as a service. Emitters declare a `consumes` dependency on it. The DAG now has an edge; init order is deterministic.

```ts
// Emitter plugin manifest
services: { consumes: ["events:vocabulary"] }

// Emitter plugin setup
async setup(ctx) {
  ctx.consumeService("events:vocabulary");
  // safe to emit — vocabulary plugin is guaranteed to have run first
  await ctx.emit("session:start");
}
```

Without the `consumes` declaration, the emitter may or may not work depending on load order — and you will not get an error when it breaks.

## Workflow examples

These are useful starting points, not requirements. The driver is the only plugin kaizen requires; everything else reflects what a given workflow needs.

### Example A — Shell harness

**Plugins:** `events`, `driver`, `shell`

| Plugin | Role | Services |
|--------|------|----------|
| `events` | Vocabulary | provides `events:vocabulary` |
| `driver` | Session loop | consumes `events:vocabulary`, `shell:exec` |
| `shell` | Command execution | provides `shell:exec` |

The driver emits lifecycle events (`session:start`, `input:received`, `shell:before`, `shell:after`, `session:end`) using names from the vocabulary service. The shell plugin provides the `shell:exec` service the driver calls for each line of input. Neither plugin knows about the other's internals.

This is not the minimum kaizen harness — that is just a driver with a `start()` that does something. This is the minimum that demonstrates the vocabulary pattern and does visible work.

### Example B — LLM coding assistant with GitHub integration

**Plugins:** `events`, `driver`, `llm-anthropic`, `tui`, `github`

| Plugin | Role | Services / Events |
|--------|------|-------------------|
| `events` | Vocabulary | provides `events:vocabulary`; defines `tool:before`, `tool:after`, `llm:response` |
| `driver` | Session loop | consumes `events:vocabulary`, `llm:provider`, `tui:channel` |
| `llm-anthropic` | LLM calls | provides `llm:provider` |
| `tui` | Terminal I/O | provides `tui:channel` |
| `github` | Git operations | subscribes to `tool:after` |

The driver runs the conversation loop. When the LLM produces a structured tool result like `{ action: "create_pr", title: "...", body: "..." }`, the driver emits `tool:after` with that payload. The GitHub plugin subscribes to `tool:after`, detects the action, and executes the GitHub API call directly.

The LLM decided *what* to do. The GitHub plugin does *how*. The driver never knows about GitHub. The GitHub plugin never talks to the LLM. Each plugin has one job; each is independently testable.

This harness can have multiple LLM plugins simultaneously. A second plugin providing `anthropic:llm` alongside `openai:llm` is valid as long as the driver picks one service name. The ecosystem does not prevent multiple implementations — naming disambiguates them.

### Example C — Pre-execution gating

**Plugins:** everything from Example B, plus `policy`

| Plugin | Role | Events |
|--------|------|--------|
| `policy` | Tool-call gate | subscribes to `tool:before` |

The `policy` plugin subscribes to `tool:before`. Before the driver lets a tool execute, it emits `tool:before` and checks the results. The policy plugin inspects the pending call and can signal rejection (by throwing, or by returning a sentinel value the driver checks). The driver then skips or aborts the tool call.

Adding or removing the `policy` plugin changes behavior without touching any other plugin. The driver does not know what policies exist; it only knows to check before executing.
```

- [ ] **Step 2: Verify the file exists and spot-check content**

```bash
grep -c "##" docs/guides/ecosystem-design.md
```

Expected: `6` (six `##` headings).

- [ ] **Step 3: Commit**

```bash
git add docs/guides/ecosystem-design.md
git commit -m "docs: add ecosystem-design guide (closes #37 partial)"
```

---

## Task 2: Patch `docs/reference/plugin-api.md` — replace stale Events prose

**Files:**
- Modify: `docs/reference/plugin-api.md:320–346`

- [ ] **Step 1: Replace the stale block**

In `docs/reference/plugin-api.md`, find and replace the block starting at line 320. The old block is:

```
kaizen core itself defines no event names — the event vocabulary is owned by
plugins. In practice, the `core-events` plugin exports the canonical event
names and payload types and registers a service that exposes them. Import
event names and payload types from `core-events`:

```ts
import { EVENTS } from "core-events";
import type {
  SessionContext,
  UserMessageContext,
  ResponseContext,
  ToolCallContext,
  ToolResultContext,
} from "core-events";
```

Conventional event names shipped by `core-events`:

| Event | Payload type | When it fires |
|-------|--------------|---------------|
| `session:start` | `SessionContext` | Once at session open |
| `session:end` | `{ sessionId }` | Once at session close |
| `session:user_message` | `UserMessageContext` | Each user turn |
| `session:response` | `ResponseContext` | Each assistant response |
| `tool:before` | `ToolCallContext` | Before `execute()` |
| `tool:after` | `ToolResultContext` | After `execute()` |
```

Replace it with:

```
kaizen core itself defines no event names — the vocabulary is owned entirely
by plugins. A plugin that emits events should call `ctx.defineEvent` for each
name during `setup()`. When the `defineEvent` calls live in a separate
vocabulary plugin, emitters must declare a `consumes` dependency on that
plugin's service to guarantee it initializes first. See
[`guides/ecosystem-design.md`](../guides/ecosystem-design.md) for the full
pattern and worked examples.
```

- [ ] **Step 2: Verify no `core-events` references remain in the Events section**

```bash
grep -n "core-events" docs/reference/plugin-api.md
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/reference/plugin-api.md
git commit -m "docs: remove stale core-events references from plugin-api.md"
```

---

## Task 3: Patch `docs/reference/plugin-standards.md` — add vocabulary guideline

**Files:**
- Modify: `docs/reference/plugin-standards.md:262–264`

- [ ] **Step 1: Add the guideline**

In `docs/reference/plugin-standards.md`, find this block (currently lines 262–264):

```
- [required] Call `ctx.defineEvent(name)` before emitting any event to declare its type
- [required] Document all events your plugin emits (in README and inline code comments)
- [required] For cross-plugin event subscriptions, declare `permissions.events.subscribe` with the event patterns you consume
```

Replace it with:

```
- [required] Call `ctx.defineEvent(name)` before emitting any event to declare its type
- [guideline] If the `defineEvent` call lives in a different plugin (a vocabulary plugin), add that plugin's vocabulary service to `services.consumes`. Without a services edge the topo-sort cannot guarantee init order — the vocabulary plugin may not have run before your first `emit`. See [`guides/ecosystem-design.md`](../guides/ecosystem-design.md).
- [required] Document all events your plugin emits (in README and inline code comments)
- [required] For cross-plugin event subscriptions, declare `permissions.events.subscribe` with the event patterns you consume
```

- [ ] **Step 2: Verify the guideline is present**

```bash
grep -n "vocabulary service" docs/reference/plugin-standards.md
```

Expected: one line containing the new guideline.

- [ ] **Step 3: Commit**

```bash
git add docs/reference/plugin-standards.md
git commit -m "docs: add vocabulary-service guideline to plugin-standards.md"
```

---

## Task 4: Patch `docs/guides/plugin-authoring.md` — testing note

**Files:**
- Modify: `docs/guides/plugin-authoring.md:258–261`

- [ ] **Step 1: Add the note**

In `docs/guides/plugin-authoring.md`, find this paragraph (currently around line 258):

```
Run with `bun test`. Cast to `any` keeps the stub minimal — only stub what
your `setup()` actually touches. If your plugin subscribes to events, capture
the `on` handlers and invoke them directly. If it consumes a service, stub
`useService` to return a test double.
```

Replace it with:

```
Run with `bun test`. Cast to `any` keeps the stub minimal — only stub what
your `setup()` actually touches. If your plugin subscribes to events, capture
the `on` handlers and invoke them directly. If it consumes a service, stub
`useService` to return a test double.

If your plugin emits events defined by a vocabulary plugin, the real harness
requires a `consumes` declaration for that vocabulary service (so init order
is pinned). In tests, stub `useService` to return the vocabulary object
directly — no services edge is needed in the test context.
```

- [ ] **Step 2: Verify the note is present**

```bash
grep -n "vocabulary" docs/guides/plugin-authoring.md
```

Expected: one line in the testing section.

- [ ] **Step 3: Commit**

```bash
git add docs/guides/plugin-authoring.md
git commit -m "docs: add vocabulary service note to plugin-authoring testing section"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|-----------------|------|
| New `ecosystem-design.md` with philosophy section | Task 1 |
| Ecosystem roles (vocabulary, driver, everything else) | Task 1 |
| Init-order principle with code sketch | Task 1 |
| Workflow examples A, B, C | Task 1 |
| `plugin-api.md` stale `core-events` prose removed | Task 2 |
| `plugin-api.md` links to ecosystem-design.md | Task 2 |
| `plugin-standards.md` new `[guideline]` entry | Task 3 |
| `plugin-authoring.md` testing section note | Task 4 |
| Archive docs untouched | (no task — nothing to do) |

All spec requirements are covered. No gaps.

**Placeholder scan:** No TBDs, TODOs, or "similar to task N" references.

**Type consistency:** No cross-task type references — this is documentation only.
