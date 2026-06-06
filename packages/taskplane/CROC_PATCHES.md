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

- none yet, beyond including this patch ledger and executable mode on `bin/taskplane.mjs`

## Planned Croc-local changes

- child-agent resource propagation
- stale generated packet folder reconciliation
- duplicate task-id detection before orchestration starts
- better progress accounting for source churn without checkbox movement
- supervisor close/skip behavior fixes
