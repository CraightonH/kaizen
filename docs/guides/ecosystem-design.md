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
