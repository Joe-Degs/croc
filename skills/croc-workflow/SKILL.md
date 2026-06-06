---
name: croc-workflow
description: Use when working inside a Croc-launched Pi and Taskplane workspace. Explains Croc's role, Taskplane routing, workspace repos, and task packet expectations.
---

# Croc Workflow

## Operating model

- Croc is the launcher and configurator.
- Pi is the coding agent.
- Taskplane is the orchestration engine.
- Task prompts decide scaffolding and stack choices. Croc does not imply a scaffold preset.

## Workspace rules

- Treat the workspace root as the coordination root.
- Editable work belongs in the repo named by the task's `## Execution Target` section.
- Task packets live in the packet repo and should keep `PROMPT.md`, `STATUS.md`, `.reviews/`, and completion markers intact.
- Do not edit Croc config, generated workspace routing, or generated Croc manifests unless the user explicitly asks.

## Worker checklist

1. Read the task packet context first.
2. Check git state before editing.
3. Make the smallest correct change in the execution target repo.
4. Run relevant checks or record blockers in `STATUS.md`.
5. Keep unrelated files untouched.
