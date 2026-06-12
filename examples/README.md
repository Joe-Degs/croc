# Examples

Example Croc configs for common launch shapes. Treat them as copy/adapt starting points, not production defaults.

## Examples

| Directory | Description |
|-----------|-------------|
| [`basic/`](basic/) | Repo-local Croc config for an existing git project |
| [`model-provider/`](model-provider/) | Dummy Pi `models.json`-style provider map |
| [`workspace-create/`](workspace-create/) | Create a new editable repo, inline skill, and generated packet repo |
| [`workspace-clone-attach/`](workspace-clone-attach/) | Mix cloned and attached repos in one workspace |
| [`web-search/`](web-search/) | Enable SearXNG-backed web search |
| [`rate-limiter-task-with-headroom/`](rate-limiter-task-with-headroom/) | Generate a Redis rate limiter task and route Pi through Headroom |

## Running an example

Pick an example and run it from the repo root, or copy its `croc.yaml` into a disposable project directory first.

```bash
EXAMPLE=examples/workspace-create/croc.yaml
croc apply --config "$EXAMPLE"
croc doctor --config "$EXAMPLE"
croc start all --config "$EXAMPLE"
```

Before starting, replace placeholder values such as `example.invalid`, absolute local paths, and `$EXAMPLE_*` environment variables with values for your machine.

Workspace examples create files relative to the current working directory unless their paths are absolute. If you copy an example config into another directory, run the commands from that directory or pass `--config` with the copied path.

After `croc start all`, use the Taskplane dashboard and CLI to follow work:

```bash
croc dashboard status --config "$EXAMPLE"
croc taskplane status --config "$EXAMPLE"
croc taskplane summary --config "$EXAMPLE"
```

When a Taskplane batch completes and integration is ready, apply it explicitly:

```bash
croc taskplane integrate --config "$EXAMPLE"
```

The dashboard listens on the configured `taskplane.dashboard.host` and `taskplane.dashboard.port`, or `127.0.0.1:8099` when left at the default. See [`../docs/config.md`](../docs/config.md) for the full config reference.
