Adversarial Review: Kaizen as a 3rd-Party Plugin Platform

Scope: Kaizen as a general-purpose platform for building anything via composable 3rd-party plugins.

---
Findings

1. The "build anything" claim is directly undermined by the exactly-one-provider-per-role constraint. Only one plugin may provide 'ui', one 'executor', one
'lifecycle'. You cannot run web + terminal UIs simultaneously, route between two LLMs, or layer lifecycle concerns. This is not a composable platform — it is a
slot-filling system with a thin JSON wrapper. The architecture forecloses the very flexibility the platform is marketing.
2. There is no sandboxing, and this is catastrophic for a 3rd-party plugin platform. Every plugin runs in-process with full Node.js access: filesystem, process.env,
child_process, network, and all other plugins' scopes. Installing one malicious or compromised npm package — dressed as a plugin — silently exfiltrates API keys,
reads SSH keys, and persists access. The current mitigation ("only install plugins you trust") is not a security model; it is a disclaimer. For a platform that
invites arbitrary 3rd-party code, this is a critical unresolved threat.
3. The provides/depends role system provides zero access control. These fields are purely for initialization ordering. A plugin declaring provides: ['emoji-prompt']
can still read /etc/shadow, open network sockets, and register tools under any name. The role system creates a false impression of capability containment. There is no
capability-based security; role declarations are suggestions, not constraints.
4. Any plugin can hijack any tool execution via tool:before. The event bus allows any plugin to subscribe to tool:before and return a fake ToolResult, silently
short-circuiting real tool execution. There is no check that the intercepting plugin has declared a relationship to the tool being intercepted. A malicious plugin can
suppress safety tools, fake their results, and manipulate LLM behavior without any log entry distinguishing the fake result from a real one.
5. Plugin resolution order is a path-confusion attack surface. Core resolves plugins in this order: builtins → $BUN_GLOBAL_ROOT → $NPM_GLOBAL_ROOT → cwd/node_modules.
A globally installed package with a name matching a local trusted plugin silently wins resolution. There is no integrity check — no hash, no GPG, no npm provenance
enforcement — at any step. A supply-chain compromise of a globally installed package is completely transparent to the loader.
6. Tool names are flat and unnamespaced, with silent conflict behavior. Two plugins registering a tool named search will collide. The registry appears to throw on
duplicate registration, but there is no prefixing convention, no conflict resolution, and no specification mandating plugin-namespaced tool names. As the plugin
ecosystem grows, name collisions become inevitable and debugging them requires reading source code, not configuration.
7. core-executor-shell ships as a built-in and calls execSync without guards. This plugin executes arbitrary shell commands synchronously on every LLM tool
invocation. execSync blocks the entire event loop, freezing all other plugins and UI for the duration of the command. More critically, any harness that accidentally
or maliciously includes this plugin gives the LLM a direct shell on the host machine. It ships enabled. The warning in source comments is not surfaced to harness
authors.
8. The harness extends chain is unvalidated and depth-unbounded. A harness can extend another harness by name. Extended harnesses can extend further harnesses. There
is no depth limit, no allowlist of what may be extended, and no cycle detection at the harness level (only plugin-level cycle detection exists). A malicious or
compromised base harness poisons every harness that extends it, and the plugin list it injects runs with full trust.
9. No plugin version pinning in harnesses. plugins in kaizen.json are bare npm package names with no version specifiers. npm install resolves to latest matching
semver. A plugin author publishing a malicious patch release, or a breaking major version, silently changes behavior for all users of any harness referencing that
plugin name. For a platform inviting 3rd-party distribution, this is a supply-chain waiting to happen.
10. The destructive command guard in core-cli is regex theater. The guard is case-sensitive: RM -RF / passes, DELETE passes, WIPE passes. It only applies to the
core-cli plugin's shell invocations — any plugin that calls child_process directly bypasses it entirely. The patterns are also semantically confused: -f is flagged,
but -f is a legitimate flag on dozens of safe commands. This guard provides false assurance to harness authors who believe it meaningfully protects against
destructive actions.
11. All plugins share process.env with zero isolation. API keys, database URLs, SSH agent sockets, session tokens — every environment variable is readable by every
plugin without declaration or consent. The recommended pattern (api_key_env) reads from env by name, but there is no mechanism preventing any other plugin from
reading the same key. A plugin can silently exfiltrate ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, or any credential present in the shell environment.
12. apiVersion mismatch is a warning, not a hard failure. The platform intends semver compatibility enforcement between plugins and core. A major version mismatch
produces a log warning and proceeds. A plugin built against core v1 running against core v3 will silently use mismatched APIs. For a 3rd-party ecosystem where plugin
authors cannot control the user's core version, this produces subtle, undebuggable runtime failures with no user-facing diagnostic.
13. The event bus has no namespace isolation. Any plugin can subscribe to events defined by any other plugin, regardless of declared dependencies. Plugin A can
observe and mutate payloads from events it has no declared relationship to. Combined with the tool:before short-circuit, this means the entire session data flow —
user messages, LLM responses, tool arguments, tool results — is observable and mutable by any loaded plugin.
14. Config shallow-merge behavior is a footgun for plugin authors. Plugin config objects are shallow-merged: local config wins on key conflicts at the top level only.
If a base harness sets a nested config object and the local config overrides one shallow key, the entire nested structure from the base is silently discarded. Plugin
authors who use nested config objects will encounter silent misconfiguration that is nearly impossible to debug without understanding merge internals.
15. There is no inter-plugin synchronous API surface. Plugins can only communicate through the event bus (async, fire-and-forget) or tool execution (schema-validated,
async). There is no mechanism for plugin A to expose a typed, synchronous service to plugin B. Complex plugin ecosystems — the kind required to "build anything" —
inevitably need shared state, registries, and synchronous coordination. The current architecture forces every such pattern through the event bus, which was not
designed for it.
16. The README is empty. The primary entry point for any developer evaluating a platform for building production systems is a file containing the string # kaizen.
There is no quickstart, no concept overview, no "how to write a plugin," no threat model summary, no compatibility matrix. DESIGN.md is excellent and thorough — and
completely inaccessible to anyone who doesn't know to look for it. A platform that cannot be discovered from its own root documentation is not ready for 3rd-party
adoption.
17. No audit trail for tool execution. Tool calls, event emissions, LLM requests, and session events are logged to stderr in debug mode only. There is no structured,
persistent audit log. For a platform handling arbitrary plugin code and LLM-driven tool execution, the absence of an auditable record means incident investigation is
impossible after the fact. This also makes compliance use cases (a valid "build anything" target) non-starters.
18. No plugin SDK, scaffolding, or validation tooling. Third-party plugin authors are given a TypeScript interface in plugin.ts and a docs file. There is no kaizen
plugin create, no template repository, no test harness, no linter for plugin manifests, no CI validation schema, and no way to verify a plugin is well-formed before
publishing. The platform invites 3rd-party plugins while providing none of the infrastructure that makes 3rd-party ecosystems sustainable.
19. RUNNING → CLOSED is a one-way, non-recoverable transition. If any plugin handler throws during a RUNNING session, execution continues but the plugin's
contribution to that session is permanently broken. There is no restart, no plugin reload, no partial session recovery. A UI plugin that loses its readline handle
mid-session cannot be reconnected. For long-lived agent sessions — an obvious "build anything" use case — this means any plugin fault is a fatal, silent session
degradation.
20. core-executor-openai is a published stub that throws on startup. It is listed in package.json dependencies, declared in documentation, and presumably referenced
in harnesses. It throws "not implemented" during setup(). This fails as a fatal error (role-providing plugin). Any harness attempting to use OpenAI silently
hard-crashes at startup with a confusing error. OpenAI is the most common LLM provider. This is not an acceptable state for a platform that positions itself as
provider-agnostic.

---
Summary verdict: Kaizen has a clean, thoughtfully designed core architecture. As an internal tool or single-author system, it is coherent. As a platform for building
anything with 3rd-party plugins, it is premature. The security model is not a model — it is an acknowledged absence. The composability constraints undercut the
platform promise. The developer ecosystem infrastructure does not exist. Shipping this as a general-purpose platform in its current state would be irresponsible.