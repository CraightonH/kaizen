# Ecosystem Design Guide — Spec

**Date:** 2026-04-22
**Issue:** #37
**Status:** approved

## Problem

Two related gaps exist in the kaizen documentation:

1. **Missing principle.** The docs say plugins must call `defineEvent` before emitting, but nothing explains what happens when the `defineEvent` call lives in a *different* plugin. The topo-sort is built solely from `services` edges; a vocabulary-only plugin with no service has no guaranteed init position relative to emitters. The result is a silent-warn-and-continue failure that authors won't notice until an emitter runs before the vocabulary plugin.

2. **Stale references.** `plugin-api.md` still names `core-events` as the canonical vocabulary plugin and shows a static `import { EVENTS } from "core-events"` pattern that does not work with the plugin system. That plugin no longer exists under that name and the import pattern was never valid at runtime.

## Goal

- Add `docs/guides/ecosystem-design.md`: a guide for plugin ecosystem and harness authors that explains roles, the vocabulary-as-service pattern, and gives real-world workflow examples anchored to the project's core philosophy.
- Patch `plugin-api.md`, `plugin-standards.md`, and `plugin-authoring.md` to remove/genericize stale `core-*` references and add a pointer to the new guide.

## Non-goals

- No changes to `src/`. The init-order behavior is correct; this is a documentation gap, not a code gap.
- No changes to archive specs (historical record).
- No validator enforcement of the vocabulary-as-service pattern (may revisit once the pattern stabilizes).
- No removal of stale type artifacts from `plugin.ts` (tracked separately in #43).

---

## Deliverable 1 — `docs/guides/ecosystem-design.md`

### Structure

#### 1. Philosophy

Opens with the kaizen design principle: *Code for what's deterministic. LLMs for what isn't.*

Unpacks what this means for plugin design: LLMs are good at reading context and producing structured intent. Plugins are good at executing that intent against real systems. The job of an ecosystem is to draw that line explicitly and give each side the right tool.

Example: an LLM deciding to open a pull request is a judgement call — non-deterministic, context-dependent. The actual GitHub API call is deterministic: given a title, body, and branch, the outcome is predictable. A well-designed ecosystem has the LLM output structured data and a GitHub plugin execute the git ops — no LLM involvement in the operation itself.

#### 2. Ecosystem roles

Describes roles by what they do, not by prescribed type names. Makes explicit that only `driver` is a singleton; everything else is unconstrained.

**Vocabulary plugin (optional, strongly recommended)**
A plugin whose `setup()` calls `defineEvent` for every event name the ecosystem uses and exposes those names as a service. Other plugins consume that service, which gives the topo-sort an edge guaranteeing the vocabulary plugin initializes first.

This is a convention, not a kaizen requirement. A driver plugin could define its own events. A plugin can inline its `defineEvent` calls. The vocabulary-as-service pattern exists to make init order explicit and auditable — use it whenever more than one plugin emits or subscribes to shared event names.

**Driver (required, exactly one)**
The plugin with `driver: true`. Owns the session loop. Declares what services it consumes; the ecosystem fills that contract. Nothing about the contract is prescribed by kaizen — the driver author decides what services the session needs.

**Everything else**
Service providers and event subscribers. Could be a terminal interface, a web server, an LLM wrapper, a GitHub client, a database adapter, a pre-execution gate, a structured-output transformer. No prescribed names, no cardinality limits beyond the one-provider-per-service rule.

When two plugins provide similar things, give them distinct service names (`openai:llm`, `anthropic:llm`). A driver that wants to fan out to multiple providers uses events — that's what the event bus is for.

#### 3. Init-order and the vocabulary pattern

Short focused section. Explains:

- Topo-sort uses only `services.consumes` / `services.provides` edges.
- A plugin that only calls `defineEvent` in `setup()` has no services edge, so its position in the init order is not pinned relative to emitters.
- `emit()` on an undefined event warns but does not throw — failures are silent.
- The fix: expose the vocabulary as a service. Emitters declare `consumes: ["vocab-plugin:vocabulary"]`. The DAG now has an edge; init order is deterministic.

Code sketch (no prose):

```ts
// vocabulary plugin
ctx.defineService("events:vocabulary", { description: "canonical event names" });
ctx.provideService("events:vocabulary", VOCAB);
for (const name of Object.values(VOCAB)) ctx.defineEvent(name);

// emitter plugin — manifest
services: { consumes: ["events:vocabulary"] }

// emitter plugin — setup
ctx.consumeService("events:vocabulary");
```

#### 4. Workflow examples

Framed as useful starting points, not requirements. Each example names the plugins used and calls out which role each plays. Explicit callout at the top of the section: the driver is the only plugin kaizen requires; everything else reflects what a given workflow needs.

**Example A — Shell harness (a working starting point)**

Plugins: `events`, `driver`, `shell`.

- `events`: vocabulary plugin. Defines `session:start`, `session:end`, `input:received`, `shell:before`, `shell:after`. Provides `events:vocabulary`.
- `driver`: consumes `events:vocabulary` and `shell:exec`. Drives the input loop; emits lifecycle events.
- `shell`: provides `shell:exec`. Executes commands. Subscribes to nothing — receives calls from the driver.

What this demonstrates: the vocabulary-as-service pattern in its simplest form. Not the minimum kaizen harness (that's just a driver), but the minimum that does something visible.

**Example B — LLM coding assistant with GitHub integration**

Plugins: `events`, `driver`, `llm-anthropic`, `github`, `tui`.

- `events`: vocabulary plugin. Adds `tool:before`, `tool:after`, `llm:response` to the shared vocabulary.
- `driver`: consumes vocabulary, `llm:provider`, `tui:channel`. Runs the conversation loop; emits `tool:before` / `tool:after` around tool execution.
- `llm-anthropic`: provides `llm:provider`. Sends messages to the Anthropic API; returns structured responses including tool calls.
- `tui`: provides `tui:channel`. Reads user input; renders agent output.
- `github`: subscribes to `tool:after`. When the tool result carries `{ action: "create_pr", ... }`, executes the GitHub API call directly — no LLM in the loop.

What this demonstrates: the deterministic/non-deterministic boundary in practice. The LLM decides *what* to do; the GitHub plugin does *how*. The driver never knows about GitHub; the GitHub plugin never talks to the LLM. Each plugin has one job.

**Example C — Pre-execution gating**

Same stack as B, plus a `policy` plugin.

- `policy`: subscribes to `tool:before`. Inspects the pending tool call; emits a rejection event or throws if the call violates declared scope rules (e.g., file writes outside the project directory). The driver checks the event bus results before proceeding.

What this demonstrates: plugins can intercept and gate behavior without the driver having any knowledge of the policy. Adding or removing the `policy` plugin changes behavior without touching any other plugin.

---

## Deliverable 2 — Stale-ref cleanup

### `docs/reference/plugin-api.md` — Events section

**Remove:**
- The `import { EVENTS } from "core-events"` code example and surrounding prose naming `core-events` as the canonical vocabulary plugin.
- The table of "Conventional event names shipped by core-events" (specific to a plugin that no longer exists under that name).
- The payload type imports (`SessionContext`, `UserMessageContext`, etc.) attributed to `core-events`.

**Replace with:**
- A brief explanation that kaizen core defines no event names — the vocabulary is owned by plugins.
- The vocabulary-as-service pattern (one paragraph + the code sketch from §3 above).
- A pointer to `docs/guides/ecosystem-design.md` for full context and examples.
- A generic example using a placeholder name (`my-events`) rather than any specific plugin.

### `docs/reference/plugin-standards.md` — Events section (line 262)

**Keep:** `[required] Call ctx.defineEvent(name) before emitting any event.`

**Add below it:** `[guideline] If the defineEvent call lives in a different plugin, add that plugin's vocabulary service to services.consumes. Without a services edge, init order is not guaranteed and the defineEvent may not have run before your first emit. See ecosystem-design.md.`

### `docs/guides/plugin-authoring.md` — Testing section

**Add:** A note in the `makeCtx()` stub section that if the plugin under test emits events defined elsewhere, the real harness requires a `consumes` declaration for the vocabulary service. The stub can provide a mock vocabulary; the real wiring requires the services edge.

---

## Spec self-review

- No TBDs or placeholders remain.
- No contradictions: all three deliverables point to the same vocabulary-as-service pattern and use consistent terminology.
- Scope is focused: docs only, three existing files + one new file.
- Ambiguity check: "strongly recommended" for vocabulary plugin is intentional — it's not a requirement. "Exactly one driver" is the only hard constraint, and it's stated clearly.
