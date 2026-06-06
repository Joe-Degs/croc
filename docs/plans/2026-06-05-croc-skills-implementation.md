# Croc Skills Implementation Plan

> **For Claude:** implement in this workspace because the Croc scaffold is still uncommitted.

**Goal:** Let Croc bundle and materialize Pi skills, including structured inline skills from `croc.yaml`, and reference required skills in generated Taskplane task prompts.

**Architecture:** Croc writes skill files under the runtime root and registers local skill paths in `.pi/settings.json` for direct Pi sessions. Because Taskplane workers run Pi with `--no-skills`, Croc also writes `## Required Skills` references into generated task packets.

**Tech stack:** TypeScript, Node filesystem APIs, Pi skill files, Croc YAML config, JSON Schema.

---

### Task 1: Config and docs

- add `skills` config and `work.tasks[].skills`
- update schema, docs, and examples

### Task 2: Skill materialization

- add bundled `croc-workflow` skill
- write inline skills to `.pi/skills/<name>/SKILL.md`
- write `.croc/skills-manifest.json`

### Task 3: Pi settings and work prompts

- add generated skill paths to `.pi/settings.json`
- set `enableSkillCommands`
- write `## Required Skills` in generated task prompts

### Task 4: Validation and smoke

- doctor-check skill names, descriptions, paths, and collisions
- run check/build
- smoke inline skill materialization and prompt references
