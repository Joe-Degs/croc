# Work Bundles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Croc materialize Taskplane-ready work packets from portable config.

**Architecture:** Croc config gains a `work` section with inline, file-backed, and directory-backed sources. `croc apply` writes task context, task folders, prompts, and generated status files under the configured Taskplane tasks path, guarded by a manifest so generated files are not clobbered accidentally.

**Tech Stack:** TypeScript, Node fs/path/crypto APIs, direct `yaml` dependency, Taskplane task packet conventions.

---

### Task 1: Config support

**Files:**
- Modify: `package.json`
- Modify: `src/core/config.ts`
- Modify: `src/cli/args.ts`

**Steps:**
1. Add direct `yaml` dependency.
2. Add `croc.yaml` and `croc.yml` config discovery before `croc.json`.
3. Parse JSON or YAML based on extension.
4. Add work bundle types and defaults.

### Task 2: Bundle materializer

**Files:**
- Create: `src/core/work-bundles.ts`
- Modify: `src/core/apply.ts`

**Steps:**
1. Resolve inline/file content relative to config path.
2. Copy existing task directories into `taskplane.tasksPath`.
3. Generate prompt folders from inline config.
4. Generate `STATUS.md` from prompt metadata and checkboxes.
5. Write `.croc/work-manifest.json` with checksums.
6. Refuse unsafe overwrites unless manifest proves Croc owns the file.

### Task 3: Validation and docs

**Files:**
- Modify: `src/core/doctor.ts`
- Modify: `README.md`

**Steps:**
1. Validate missing file/directory references.
2. Warn when orchestration is likely to fail in a git repo with no commits.
3. Document inline, file-backed, and directory-backed work bundles.

### Task 4: Verification

**Commands:**
- `npm run check`
- `npm run build`
- disposable config smoke for YAML inline task materialization
- disposable directory-source smoke
