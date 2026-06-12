# croc

Croc is a Taskplane launcher and profile manager for Pi.

It configures project-local Pi settings, Taskplane settings, Croc/Pi skills, optional web search, optional tmux wrapping, and dashboard startup. It does not replace Pi or Taskplane.

Taskplane is bundled as a Croc dependency. `croc apply` writes that local Taskplane package path into `.pi/settings.json`, so Pi loads Taskplane without a separate `pi install npm:taskplane` step.

## Commands

```bash
croc init
croc apply
croc doctor
croc start all
croc attach
croc dashboard start
croc dashboard stop
croc dashboard status
```

## Install from GitHub releases

https://github.com/Joe-Degs/croc/releases/latest

```bash
npm install -g <release-asset-url>
```

Verify the install:

```bash
croc version
croc help
```

Requirements:

- Node.js `>=22.19.0`
- git on `PATH`
- Pi installed and available on `PATH`
- tmux on `PATH` if `runtime.tmux.enabled` is true

## Quick start

Create a config in your project:

```bash
croc init
```

Apply it to write project-local Pi and Taskplane settings:

```bash
croc apply
croc doctor
```

Start a Croc-launched Pi session:

```bash
croc start all
```

If tmux is enabled, attach to the running session later:

```bash
croc attach
```

Start or inspect the dashboard:

```bash
croc dashboard start
croc dashboard status
```

## Inside Pi

Croc registers a provider extension that adds workflow controls to Croc-launched Pi sessions:

```text
/croc-status
/croc-workflows
/croc-doctor
/croc-dashboard status
/croc-config
```

Agents can also use matching tools:

```text
croc_status()
croc_workflows()
croc_doctor()
croc_dashboard({ action: "status" })
croc_config()
```

`/croc-apply --confirm` and `croc_apply({ confirm: true })` rewrite generated runtime files. Use them only after explicit operator confirmation.

## Configuration

Croc reads `croc.yaml`, `croc.yml`, or `croc.json` from the current project unless `--config <path>` is provided. If more than one default config exists, pass `--config` so Croc does not guess.

See [`docs/config.md`](docs/config.md) for the config reference and [`schemas/croc.schema.json`](schemas/croc.schema.json) for editor validation.

Maintainer release steps live in [`docs/release.md`](docs/release.md).

Web search is conditional. Set `batteries.webSearch.enabled` and provide a SearXNG URL before applying.

Skills are enabled by default. Croc registers the bundled `croc-workflow` skill for direct Pi sessions and writes required-skill references into generated Taskplane prompts.

## Examples

See [`examples/`](examples/) for copy/adapt config shapes, including repo-local mode, workspace repo creation, inline skills, clone/attach workspaces, web search, model providers, and Headroom-routed Taskplane work.

Example flow:

```bash
EXAMPLE=examples/workspace-create/croc.yaml
croc apply --config "$EXAMPLE"
croc doctor --config "$EXAMPLE"
croc start all --config "$EXAMPLE"
croc taskplane status --config "$EXAMPLE"
```

Use [`examples/rate-limiter-task-with-headroom/`](examples/rate-limiter-task-with-headroom/) to see a generated Redis rate limiter task packet routed through a managed Headroom proxy. Replace placeholder providers, upstream URLs, and environment variables before running an example locally.

## Workspaces

Croc can bootstrap a Taskplane workspace with one or more editable git repos. Created repos are plain git repos only: Croc does not scaffold apps. Tell Pi what stack to use in the task prompt.

```yaml
workspace:
  enabled: true
  root: .croc/workspace
  defaultRepo: site
  taskPacketRepo: packets
  strictRouting: true
  repos:
    - id: site
      mode: create
      path: repos/site
      initialBranch: main
      initialCommit: true

    - id: api
      mode: clone
      path: repos/api
      remote: git@github.com:example/api.git

    - id: shared
      mode: attach
      path: /Users/me/src/shared
```

For `mode: create`, Croc creates the directory, initializes git, sets the branch, writes a tiny seed file, and creates the initial commit by default. That initial commit matters because Taskplane needs a valid branch and `HEAD` before it can create worker worktrees.

If `taskPacketRepo` is not listed in `repos`, Croc creates it automatically under the workspace root. `croc apply` writes `.pi/taskplane-workspace.yaml`, `.pi/APPEND_SYSTEM.md`, and `.croc/session.json` in the workspace root.

## Work bundles

Croc can materialize Taskplane work from config. This makes a project portable: copy the config into an environment, run `croc apply`, then `croc start all`.

```yaml
configVersion: 1

taskplane:
  tasksPath: taskplane-tasks
  taskPrefix: TASK

work:
  enabled: true
  overwrite: if-generated
  context: |
    # Project context

    Build the smallest correct change and record blockers in STATUS.md.
  sources:
    - directory: ./task-packets
      mode: copy
  tasks:
    - id: TASK-001
      title: Dashboard smoke test
      repo: site
      size: S
      reviewLevel: 0
      dependencies: []
      contextDocs: []
      fileScope:
        - taskplane-dashboard-smoke.md
      prompt: |
        Create `taskplane-dashboard-smoke.md` in the project root.

        ### Step 0: Preflight

        - [ ] Read the context
        - [ ] Check git state

        ### Step 1: Implement

        - [ ] Create the smoke file

        ### Step 2: Verify

        - [ ] Confirm the file exists
```

`croc apply` writes `taskplane-tasks/CONTEXT.md`, generated task folders, `PROMPT.md`, missing `STATUS.md` files, and `.croc/work-manifest.json`. It will not overwrite existing `STATUS.md` files. For generated prompts and context files, `overwrite: if-generated` only overwrites files whose current checksum still matches the manifest.

In workspace mode, `work.tasks[].repo` writes a `## Execution Target` section into each generated `PROMPT.md`. With `strictRouting: true`, every generated task must declare a repo.

## Skills

Croc can bundle, register, and materialize Pi skills:

```yaml
skills:
  enabled: true
  bundled:
    - croc-workflow
  inline:
    - name: landing-page
      description: Use when building a compact product landing page.
      body: |
        Prefer one small HTML file unless the task asks for a framework.
  work:
    include:
      - croc-workflow

work:
  tasks:
    - id: TASK-001
      title: Build landing page
      repo: site
      skills:
        - landing-page
      prompt: Build the page.
```

Inline skills are written under `.pi/skills/` and tracked in `.croc/skills-manifest.json`. Direct Pi sessions load configured skills from `.pi/settings.json`; generated Taskplane prompts also list required skills because Taskplane workers run with skills disabled.
