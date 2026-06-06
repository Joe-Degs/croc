# Workspace Bootstrap Implementation Plan

> **For Claude:** implement task-by-task in the current Croc scaffold. Do not create a worktree because this initial scaffold is uncommitted.

**Goal:** Add Croc workspace mode so Croc can create, clone, or attach editable git repos, materialize Taskplane task packets in a packet repo, and start Pi from the generated workspace root.

**Architecture:** Keep Croc as a launcher/configurator. `apply` prepares repos, writes workspace files under the workspace root, then writes Pi and Taskplane config there. `start`, `doctor`, and dashboard commands resolve the same effective root before running Taskplane or Pi.

**Tech stack:** TypeScript, Node.js filesystem/process APIs, YAML config files, Taskplane workspace mode, Pi extension hooks.

---

### Task 1: Config schema

**Files:**
- Modify: `src/core/config.ts`

**Steps:**
- Add `workspace` config to `CrocConfig` with `enabled`, `root`, `defaultRepo`, `taskPacketRepo`, `strictRouting`, and `repos`.
- Add repo modes `create`, `clone`, and `attach`.
- Add optional `repo` to `work.tasks[]` for Taskplane execution routing.

### Task 2: Workspace writer

**Files:**
- Create: `src/core/workspace.ts`
- Modify: `src/core/apply.ts`

**Steps:**
- Resolve the effective runtime root to `workspace.root` when enabled, otherwise `cwd`.
- Prepare each editable repo as a git repo root.
- Generate the packet repo when `taskPacketRepo` is not one of the configured repos.
- Write `.pi/taskplane-workspace.yaml`, `.pi/APPEND_SYSTEM.md`, and `.croc/session.json` under the workspace root.
- Write Taskplane/Pi settings against the effective root.

### Task 3: Work bundle routing

**Files:**
- Modify: `src/core/work-bundles.ts`

**Steps:**
- Materialize work bundles into the effective root.
- When a task has `repo`, add a `## Execution Target` section with `Repo: <id>` to generated `PROMPT.md`.
- Validate that task repo IDs exist when workspace mode is enabled.

### Task 4: Runtime commands

**Files:**
- Modify: `src/core/runtime.ts`
- Modify: `src/core/dashboard.ts`
- Modify: `src/core/doctor.ts`
- Modify: `src/main.ts`

**Steps:**
- Run Pi and Taskplane dashboard from the effective root.
- Keep `CROC_CONFIG` pointing at the source Croc config.
- Make doctor validate generated workspace files and repo baselines.

### Task 5: Croc extension

**Files:**
- Modify: `src/core/pi-settings.ts`
- Modify: `src/extensions/provider.ts`

**Steps:**
- Always load the Croc extension.
- Read YAML or JSON Croc config.
- Register `/croc-status`.
- Set a concise status line.
- Append Croc workspace context to `before_agent_start`.

### Task 6: Docs and verification

**Files:**
- Modify: `README.md`

**Steps:**
- Document workspace config with `create`, `clone`, and `attach` examples.
- Run `npm run check` and `npm run build`.
- Smoke a disposable workspace with a created repo and packet repo.
