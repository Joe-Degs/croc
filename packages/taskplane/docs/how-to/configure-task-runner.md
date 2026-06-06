# Configure Task Execution Settings

This guide explains how to configure worker agents, reviewer agents, context limits, task areas, and testing commands for Taskplane task execution.

## Where settings live

- **Primary:** `.pi/taskplane-config.json` — under the `taskRunner` key
- **Interactive:** Run `/taskplane-settings` to view and edit settings in a TUI
- **Legacy fallback:** `.pi/task-runner.yaml` (still loaded if present, but JSON takes precedence)

If neither file exists, run:

```bash
taskplane init
```

---

## Minimal working config

A small config from `taskplane init` is enough to run tasks:

```json
{
  "taskRunner": {
    "taskAreas": {
      "general": {
        "path": "taskplane-tasks",
        "prefix": "TP",
        "context": "taskplane-tasks/CONTEXT.md"
      }
    },
    "testing": {
      "commands": {
        "test": "npm test",
        "build": "npm run build"
      }
    }
  }
}
```

Taskplane fills missing fields with defaults.

---

## Full section guide

### `taskRunner.project`

```json
{
  "taskRunner": {
    "project": {
      "name": "Example Project",
      "description": "Short description"
    }
  }
}
```

Used in reviewer prompts and task context.

### `taskRunner.paths`

```json
{
  "taskRunner": {
    "paths": {
      "tasks": "taskplane-tasks",
      "architecture": "docs/architecture.md"
    }
  }
}
```

Project path metadata for prompts and context.

### `taskRunner.testing.commands`

```json
{
  "taskRunner": {
    "testing": {
      "commands": {
        "test": "npm test",
        "build": "npm run build",
        "lint": "npm run lint"
      }
    }
  }
}
```

These commands are injected into execution and review context. Keep only safe, relevant commands.

### `taskRunner.standards`

```json
{
  "taskRunner": {
    "standards": {
      "docs": [
        "README.md",
        "CONTRIBUTING.md"
      ],
      "rules": [
        "Keep changes scoped to the task",
        "Update docs when behavior changes"
      ]
    }
  }
}
```

Global coding and review standards.

### `taskRunner.standardsOverrides`

```json
{
  "taskRunner": {
    "standardsOverrides": {
      "backend": {
        "docs": ["docs/backend-standards.md"],
        "rules": ["Do not bypass auth middleware"]
      }
    }
  }
}
```

Area-specific standards override global standards when the task folder path matches that area.

### `taskRunner.worker`

```json
{
  "taskRunner": {
    "worker": {
      "model": "",
      "tools": "read,write,edit,bash,grep,find,ls",
      "thinking": ""
    }
  }
}
```

- `model: ""` — inherit the active session model.
- `thinking: ""` — inherit the active session thinking mode (`"inherit"` alias is also accepted).
- `excludeExtensions: []` — package specifiers to exclude from extension forwarding for worker agents (exact match). See [Extension Forwarding](#extension-forwarding) below.

### `taskRunner.reviewer`

```json
{
  "taskRunner": {
    "reviewer": {
      "model": "",
      "tools": "read,write,bash,grep,find,ls",
      "thinking": "high"
    }
  }
}
```

Set `reviewer.model` explicitly (optional) to use a different model than the worker for stronger cross-model review.
- `excludeExtensions: []` — package specifiers to exclude from extension forwarding for reviewer agents (exact match).

### `taskRunner.context`

```json
{
  "taskRunner": {
    "context": {
      "workerContextWindow": 200000,
      "warnPercent": 70,
      "killPercent": 85,
      "maxWorkerIterations": 20,
      "maxReviewCycles": 2,
      "noProgressLimit": 3,
      "maxWorkerMinutes": 30
    }
  }
}
```

Controls loop safety, context pressure, and retry limits.

### `taskRunner.taskAreas` (required in practice)

```json
{
  "taskRunner": {
    "taskAreas": {
      "general": {
        "path": "taskplane-tasks",
        "prefix": "TP",
        "context": "taskplane-tasks/CONTEXT.md"
      }
    }
  }
}
```

This is the most important section for discovery and orchestration.

### `taskRunner.referenceDocs`

```json
{
  "taskRunner": {
    "referenceDocs": {
      "overview": "README.md",
      "architecture": "docs/architecture.md"
    }
  }
}
```

Reference document catalog used by task-creation workflows.

### `taskRunner.neverLoad`

```json
{
  "taskRunner": {
    "neverLoad": [
      "PROGRESS.md",
      "HANDOFF-LOG.md"
    ]
  }
}
```

Docs that should be excluded from task context loading.

### `taskRunner.selfDocTargets`

```json
{
  "taskRunner": {
    "selfDocTargets": {
      "techDebt": "CONTEXT.md ## Technical Debt / Future Work"
    }
  }
}
```

Targets where agents should log discoveries.

### `taskRunner.protectedDocs`

```json
{
  "taskRunner": {
    "protectedDocs": [
      "docs/",
      "templates/"
    ]
  }
}
```

Paths requiring explicit approval before edits.

---

## Extension Forwarding

Taskplane automatically forwards third-party Pi extensions installed in your project or global settings to spawned worker, reviewer, and merge agents. Extensions are discovered from `.pi/settings.json` (project-level) and `~/.pi/agent/settings.json` (global), with taskplane itself always filtered out.

The `--no-extensions` flag remains on all spawned agents to prevent cwd-based auto-discovery. Forwarded extensions are passed as explicit `-e` flags, which are honored alongside `--no-extensions`.

### Per-agent-type exclusions

You can exclude specific extensions from individual agent types:

```json
{
  "taskRunner": {
    "worker": { "excludeExtensions": ["npm:pi-smart-fetch"] },
    "reviewer": { "excludeExtensions": [] }
  },
  "orchestrator": {
    "merge": { "excludeExtensions": [] }
  }
}
```

Exclusions use exact package specifier matching. Empty arrays (the default) mean all discovered extensions are forwarded.

### Settings TUI

Use `/taskplane-settings` → **Agent Extensions** to interactively toggle extensions per agent type. The TUI discovers installed packages automatically — no manual text entry needed.

---

## Recommended baseline for most projects

- Keep `worker.model` empty (inherit from session)
- Optionally set a fixed `reviewer.model` for cross-model review
- Keep `maxWorkerIterations` modest (10–20)
- Keep `taskAreas` small at first, then split by domain
- Add only test/build commands that are deterministic

---

## Validate your config

After edits:

```bash
taskplane doctor
```

Then in pi:

```
/orch path/to/PROMPT.md
```

Or to plan all tasks:

```
/orch-plan all
```

---

## Related guides

- [Define Task Areas](define-task-areas.md)
- [Configure Orchestrator Settings](configure-task-orchestrator.md)
- [`/taskplane-settings` Reference](../reference/configuration/taskplane-settings.md)
