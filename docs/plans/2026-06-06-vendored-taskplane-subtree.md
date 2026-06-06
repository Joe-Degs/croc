# Vendored Taskplane Subtree Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Croc install and run its own local Taskplane engine package while preserving an upstream update path.

**Architecture:** Taskplane lives under `packages/taskplane` as a git subtree from upstream. Croc depends on it as a local package and bundles it for npm distribution so `npm install croc` includes Croc's Taskplane. Croc's `bundled` Taskplane resolver points at the local package in source checkouts and at the bundled dependency in installed packages.

**Tech Stack:** Node.js, npm workspaces/file dependencies, git subtree, TypeScript ESM, Pi package manifests.

---

### Task 1: Add Taskplane As Subtree

**Files:**
- Create: `packages/taskplane/**`

**Steps:**
- Add upstream remote `taskplane-upstream` if missing.
- Fetch upstream.
- Add upstream Taskplane into `packages/taskplane` using `git subtree add --prefix=packages/taskplane taskplane-upstream main` or the actual default branch.
- Verify `packages/taskplane/package.json` has the `pi.extensions` and `pi.skills` manifest.

### Task 2: Wire Npm Package Shape

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Steps:**
- Add npm workspaces for `packages/taskplane`.
- Change `taskplane` dependency to `file:packages/taskplane`.
- Add `bundledDependencies: ["taskplane"]`.
- Run `npm install --ignore-scripts`.

### Task 3: Make Bundled Resolution Explicit

**Files:**
- Modify: `src/core/paths.ts`
- Modify: `src/core/doctor.ts`

**Steps:**
- Prefer `packages/taskplane/package.json` when present in a source checkout.
- Fall back to `require.resolve("taskplane/package.json")` for installed packages.
- Keep `getBundledTaskplaneBinPath()` derived from package root.
- Make doctor report the resolved Taskplane package path and verify the Pi manifest.

### Task 4: Verify Distribution Shape

**Commands:**
- `npm run check`
- `npm run build`
- `npm pack --dry-run`
- `npm run dev -- --cwd "/Users/hubteluser/hubtel/movie-night-croc-test" doctor`

**Expected:**
- checks pass
- dry-run pack includes the package shape required for bundled Taskplane or exposes any packaging gap clearly
- doctor reports the local `packages/taskplane` path in the worktree
