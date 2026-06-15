# Croc config reference

Croc reads `croc.yaml`, `croc.yml`, or `croc.json` from the current directory unless `--config <path>` is provided. Config files are partial: Croc merges them with defaults from `src/core/config.ts`.

Use `schemas/croc.schema.json` for editor validation. YAML users can add this comment at the top of a config:

```yaml
# yaml-language-server: $schema=../schemas/croc.schema.json
```

## Top level

| Field | Description |
|-------|-------------|
| `configVersion` | config format version, currently `1` |
| `profile` | label shown in Croc-aware Pi sessions |
| `runtime` | tmux and launch behavior |
| `workspace` | optional Taskplane workspace bootstrap |
| `skills` | Pi skill registration and generated work prompt skill references |
| `pi` | Pi command, model, thinking, and optional Pi provider registration |
| `taskplane` | Taskplane package/config/dashboard settings |
| `work` | portable Taskplane task packet materialization |
| `batteries` | optional tools such as web search |

## Workspace

`workspace.enabled: true` makes Croc run Pi and Taskplane from `workspace.root`. The source directory can just hold `croc.yaml`.

Relative `workspace.root` paths resolve from the Croc source root (`--cwd` or the process cwd). Relative repo paths resolve from `workspace.root`.

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
```

Workspace repo modes:

| Mode | Behavior |
|------|----------|
| `create` | create the directory, run `git init`, set the branch, write a seed file, and create an initial commit by default |
| `clone` | clone `remote` into `path`; if `path` exists, it must already be a git repo root |
| `attach` | use an existing local git repo root without copying it |

`initialCommit` defaults to `true` for `create` because Taskplane needs a valid branch and `HEAD` before it can create worker worktrees.

If `workspace.taskPacketRepo` is not listed in `workspace.repos`, Croc creates it automatically under `workspace.root`.

Croc writes these workspace files:

| File | Purpose |
|------|---------|
| `.pi/taskplane-workspace.yaml` | Taskplane workspace routing |
| `.pi/APPEND_SYSTEM.md` | static Croc context loaded by Pi |
| `.croc/session.json` | dynamic Croc context read by the extension |

## Skills

`skills.enabled: true` registers Pi skills for Croc-launched sessions. Croc includes `croc-workflow` by default.

```yaml
skills:
  enabled: true
  enableCommands: true
  bundled:
    - croc-workflow
  paths:
    - ./skills
  inline:
    - name: landing-page
      description: Use when building a compact product landing page.
      body: |
        # Landing page guidance

        Prefer one small HTML file unless the task asks for a framework.
  work:
    include:
      - croc-workflow
```

Skill sources:

| Field | Behavior |
|-------|----------|
| `skills.bundled` | built-in Croc skills, currently `croc-workflow` |
| `skills.paths` | external skill files or directories; relative paths resolve from the Croc config file |
| `skills.inline` | structured inline skills written to `.pi/skills/<name>/SKILL.md` |

Inline skills need `name`, `description`, and `body`. Names must use lowercase letters, numbers, and single hyphens. Croc writes inline skill checksums to `.croc/skills-manifest.json` and refuses to overwrite inline skills edited outside Croc.

Direct Croc-launched Pi sessions load skills from `.pi/settings.json`. Taskplane workers run Pi with skills disabled, so generated work prompts include a `## Required Skills` section instead. Use `skills.work.include` for skills every generated task should read, and `work.tasks[].skills` for task-specific skills.

## Work bundles

`work.enabled: true` materializes Taskplane task packets from config.

```yaml
work:
  enabled: true
  overwrite: if-generated
  context: |
    # Project context

    Build the smallest correct change.
  tasks:
    - id: TASK-001
      title: Build tiny website
      repo: site
      skills:
        - landing-page
      prompt: |
        Create a single-file website.
```

`work.tasks[].repo` writes a `## Execution Target` section into generated `PROMPT.md` files. With `workspace.strictRouting: true`, every generated task must set `repo`.

`work.tasks[].skills` adds task-specific entries to generated `## Required Skills` prompt sections. Global entries come from `skills.work.include`.

`work.overwrite` controls generated files:

| Value | Behavior |
|-------|----------|
| `never` | fail if a generated file already exists |
| `if-generated` | overwrite only files still matching `.croc/work-manifest.json` |
| `always` | overwrite generated paths without checksum protection |

Croc does not overwrite existing `STATUS.md` files.

## Pi and Taskplane

Croc does not ship model, provider endpoint, credential, or thinking defaults. Omit model fields to let Pi use the user's normal model configuration.

Use `pi.models` only when a project should register project-local providers through Croc's extension. `pi.models` follows Pi's `models.json` shape:

| Field | Behavior |
|-------|----------|
| `pi.models.file` | optional path to a Pi `models.json`-shaped file; relative paths resolve from the Croc config file |
| `pi.models.providers` | inline provider map using Pi provider entries |

When both are set, Croc loads providers from `pi.models.file` first and then applies inline providers. Inline providers replace same-named file providers. Croc passes provider entries to Pi without resolving, copying, or logging credential values. Use Pi's normal value syntax for credentials: `$ENV_VAR`, `${ENV_VAR}`, `!command`, or a literal value.

Full dummy provider shape:

```yaml
pi:
  command: pi
  model: example-llm/example-chat
  thinking: high
  models:
    providers:
      example-llm:
        name: Example LLM
        baseUrl: https://llm.example.invalid/v1
        api: openai-completions
        apiKey: "$EXAMPLE_LLM_API_KEY"
        authHeader: true
        models:
          - id: example-chat
            name: Example Chat
            reasoning: false
            input:
              - text
            contextWindow: 128000
            maxTokens: 8192
            cost:
              input: 0
              output: 0
              cacheRead: 0
              cacheWrite: 0

taskplane:
  workerModel: example-llm/example-chat
  reviewerModel: example-llm/example-chat
  mergeModel: example-llm/example-chat
  supervisorModel: example-llm/example-chat
  workerThinking: high
  reviewerThinking: high
  mergeThinking: high
```

External Pi models file:

```yaml
pi:
  model: example-llm/example-chat
  models:
    file: ./models.json
```

Taskplane is bundled by default:

```yaml
taskplane:
  packageSource: bundled
  maxLanes: 3
  compactionKillPolicy: immediate
  dashboard:
    enabled: true
    host: 127.0.0.1
    port: 8099
```

`taskplane.dashboard.host` defaults to `127.0.0.1`. Set it to `0.0.0.0` or a specific interface address when the dashboard must be reachable from another machine.

`taskplane.tasksPath` is relative to the runtime root. In workspace mode Croc rewrites it so tasks live inside `workspace.taskPacketRepo`.

`taskplane.compactionKillPolicy` passes through to Taskplane as `taskRunner.context.compactionKillPolicy`. Allowed values are `immediate` and `defer`; the default is `immediate`. `immediate` preserves the current context-limit behavior. `defer` lets Taskplane wait briefly for Pi compaction before killing a worker at the context limit. Croc and Taskplane do not enable Pi compaction or change Pi compaction settings. Pi owns whether compaction is enabled and how summaries are produced.

When `defer` is enabled, a successful Pi compaction clears the pending context kill. Failed, skipped, or aborted compaction does not clear it unless Pi reports a retry, and retries remain bounded by Taskplane's internal grace timer.

## Batteries

Web search is optional and currently targets SearXNG:

```yaml
batteries:
  webSearch:
    enabled: true
    provider: searxng
    url: https://searxng.example.invalid
```

When enabled, Croc adds the configured web-search package to `.pi/settings.json` and passes `SEARXNG_URL` to Pi.

### batteries.headroom

Headroom is an optional Croc battery for routing selected Pi providers through a Headroom compression proxy. Configure it under `batteries.headroom`; Croc owns proxy readiness and routed provider `baseUrl` rewrites, while Pi model config remains the source of truth for provider identity, credentials, model metadata, context windows, and model selection.

Managed mode lets Croc start `headroom proxy` in the background during `croc start`:

```yaml
batteries:
  headroom:
    enabled: true
    proxy:
      mode: managed
      command: headroom
      url: http://127.0.0.1:18787
      telemetry: off
      requireReady: true
      startupTimeoutSeconds: 120
      targets:
        openai:
          upstreamUrl: https://llm.example.invalid/v1
    routing:
      providers:
        example-llm:
          target: openai
    ccr:
      mode: disabled
```

`proxy.command` must resolve to a working Headroom CLI with proxy dependencies installed. A package install normally provides `headroom`; a local Headroom source checkout may need an absolute command path such as `.venv/bin/headroom` after installing the `proxy` extra. Croc inherits the environment from `croc start`, so local development-only variables such as `HEADROOM_REQUIRE_RUST_CORE=false` can be set on that command when testing a degraded Headroom checkout. Do not use degraded mode as a production fix.

External mode uses an already-running proxy. Croc checks readiness but does not start, stop, or mutate the proxy:

```yaml
batteries:
  headroom:
    enabled: true
    proxy:
      mode: external
      url: http://127.0.0.1:18787
    routing:
      providers:
        example-llm:
          target: openai
    ccr:
      mode: bridge
```

Route targets in v1:

| Target | Routed provider `baseUrl` |
|--------|----------------------------|
| `openai` | `${proxy.url}/v1` |
| `anthropic` | `${proxy.url}` |
| `gemini` | rejected in v1 |
| `cloudcode` | rejected in v1 |

Prefer `batteries.headroom.routing.providers` over writing routed provider URLs by hand:

```yaml
pi:
  models:
    providers:
      example-llm:
        baseUrl: http://127.0.0.1:18787/v1
```

If a provider is routed through Headroom and also declares `pi.models.providers.<name>.baseUrl`, Croc fails unless the explicit value equals the derived Headroom URL after trailing slash normalization.

#### OpenAI provider compatibility

For OpenAI-compatible providers, keep the Pi provider `api` aligned with the API shape exposed by the upstream:

| Pi provider `api` | Headroom endpoint |
|-------------------|-------------------|
| `openai-completions` | `${proxy.url}/v1/chat/completions` |
| `openai-responses` | `${proxy.url}/v1/responses` |

Croc only rewrites the routed provider `baseUrl` to Headroom. It does not change the provider `api`, credentials, model metadata, request shape, or Pi parser. Use the same `api` value the provider would use without Headroom. Switch APIs only when the upstream model is intentionally exposed through a different OpenAI API shape.

Custom Croc-local models should include the model metadata Pi expects, especially `contextWindow`, `maxTokens`, and `cost`. Missing metadata can surface as Pi-side display or usage-accounting errors even when the Headroom request itself succeeds.

`ccr.mode: disabled` is the default. In v1, disabled means Croc does not register the Pi-side `headroom_retrieve` bridge. It does not alter Headroom's internal CCR injection behavior.

`ccr.mode: bridge` opts in to `headroom_retrieve`. The bridge uses `headroom-ai` to return original uncompressed content, so output may enter model context and Taskplane event streams. Local proxy origins (`localhost`, `127.0.0.1`, and `::1`) are allowed; any other proxy origin must be listed exactly in `ccr.trustedOrigins`.

`croc apply` stays offline. It validates config and writes runtime files only; it does not start Headroom, check `/readyz`, or perform Headroom process work.

`croc start` starts a managed proxy or checks an external proxy, waits for `/readyz`, then launches the dashboard and Pi. Croc does not add a Headroom dashboard panel in v1. Use Headroom's native dashboard for Headroom metrics and detailed proxy state.

For end-to-end smoke tests, use separate ports for Headroom and the Taskplane dashboard. If a dashboard port is already occupied, choose another port before treating dashboard startup as healthy.

Managed mode writes:

| File | Purpose |
|------|---------|
| `${runtimeRoot}/.croc/headroom/proxy.pid` | managed proxy PID |
| `${runtimeRoot}/.croc/headroom/proxy-state.json` | managed launch state |
| `${runtimeRoot}/.croc/headroom/proxy.stdout.log` | managed proxy stdout |
| `${runtimeRoot}/.croc/headroom/proxy.stderr.log` | managed proxy stderr |

Managed mode in v1 is not a restart supervisor. Croc avoids duplicate starts, removes stale PID/state files, and fails rather than killing unknown live processes. Treat Headroom logs as sensitive because they may contain upstream details.
