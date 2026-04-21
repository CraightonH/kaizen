
## Documentation

Before invoking `superpowers:finishing-a-development-branch`, run `kaizen:update-docs`.
This is mandatory for any branch that changes behavior, API surface, or CLI commands.
Skip only for chore/fix PRs with no externally visible change.

## Superpowers

You have superpowers. At the start of every conversation, invoke `superpowers:using-superpowers`
via the Skill tool BEFORE any other action or response. This establishes the full skill-usage
protocol. Skip this only if you were dispatched as a subagent to execute a specific task.

Available superpowers skills (invoke via Skill tool):
- `superpowers:brainstorming` — structured brainstorming sessions
- `superpowers:writing-plans` — write implementation plans
- `superpowers:executing-plans` — execute a written plan step-by-step
- `superpowers:test-driven-development` — TDD workflow
- `superpowers:systematic-debugging` — structured debugging
- `superpowers:verification-before-completion` — verify work before marking done
- `superpowers:requesting-code-review` — prepare code for review
- `superpowers:receiving-code-review` — act on code review feedback
- `superpowers:finishing-a-development-branch` — branch cleanup/ship checklist
- `superpowers:dispatching-parallel-agents` — spawn parallel subagents
- `superpowers:subagent-driven-development` — subagent orchestration
- `superpowers:using-git-worktrees` — git worktree workflows
- `superpowers:writing-skills` — write new skills

Slash commands (available as `/brainstorm`, `/write-plan`, `/execute-plan`).
Agent: `superpowers:code-reviewer` (in `.claude/agents/`).

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
