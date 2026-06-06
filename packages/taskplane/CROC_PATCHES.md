# Croc Taskplane Patch Ledger

This package is imported into Croc as a git subtree from upstream Taskplane.

Upstream remote:

```bash
git remote add taskplane-upstream https://github.com/HenryLach/taskplane.git
git fetch taskplane-upstream main
```

Update flow:

```bash
git subtree pull --prefix=packages/taskplane taskplane-upstream main
```

Local Croc changes should be recorded here so upstream drift is easy to review.

## Current Croc-local changes

- `settings-loader.ts` reads Pi `packages`, explicit `extensions`, and `skills` from project and global settings. Relative extension/skill paths are rebased from their settings directory. Package object entries with `extensions` filters are not expanded into unfiltered package `-e` flags. Worker, reviewer, and merge child agents forward packages/extensions with `-e` and skills with `--skill` while still disabling auto-discovery.
- `agent-bridge-extension.ts` clears the reviewer child-process timeout when the reviewer exits, preventing reviewed worker sessions from lingering on the 10-minute timer.
- Croc's `writePiSettings` reconciles stale generated Taskplane package and provider extension paths before adding the current bundled paths, preventing duplicate old/new Croc resources from being forwarded to child agents.
- patch ledger and executable mode on `bin/taskplane.mjs`

## Planned Croc-local changes

- stale generated packet folder reconciliation
- duplicate task-id detection before orchestration starts
- better progress accounting for source churn without checkbox movement
- supervisor close/skip behavior fixes
