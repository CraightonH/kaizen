# kaizen docs

kaizen is a plugin loader, event bus, permissioned host API, and resolver for
building LLM harnesses from composable plugins. The binary ships with zero
plugins — everything is a plugin.

## Plugin Author Journey

If you're building a plugin or marketplace, work through these in order:

1. [What is a plugin and what can it do?](concepts/plugin-model.md)
2. [How do I scaffold a new plugin?](guides/plugin-authoring.md#scaffold)
3. [How do I register tools?](guides/plugin-authoring.md#tools)
4. [How do I use the host API (secrets, config, events)?](reference/host-api.md)
5. [How do I declare services and dependencies?](concepts/plugin-model.md#services)
6. [How do I test my plugin locally?](guides/plugin-authoring.md#testing)
7. [How do I validate it?](guides/plugin-authoring.md#validate)
8. [How do I publish to a marketplace?](guides/marketplace-authoring.md)

A link that leads to a missing or incomplete section is a known documentation
gap. Open an issue or check `docs/superpowers/specs/` for in-progress work.

## Index

### Concepts
- [Platform](concepts/platform.md) — why kaizen exists and what it is
- [Architecture](concepts/architecture.md) — kernel model, event bus, registry
- [Plugin Model](concepts/plugin-model.md) — what plugins are and how they load
- [Security](concepts/security.md) — plugin security model and permission tiers
- [Harnesses](concepts/harnesses.md) — sharing pre-configured plugin stacks

### Guides
- [Plugin Authoring](guides/plugin-authoring.md) — build a plugin from scratch
- [Marketplace Authoring](guides/marketplace-authoring.md) — publish a marketplace
- [Contributing to Core](guides/contributing.md) — contribute to kaizen itself

### Reference
- [Plugin API](reference/plugin-api.md) — types, manifest schema, exported API
- [Host API](reference/host-api.md) — APIs plugins call into kaizen
- [Plugin Standards](reference/plugin-standards.md) — required rules and guidelines
- [Plugin Secrets](reference/plugin-secrets.md) — secret provider interface
