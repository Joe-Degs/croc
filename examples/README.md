# Examples

Example Croc configs for common launch shapes.

## Examples

| Directory | Description |
|-----------|-------------|
| [`basic/`](basic/) | Repo-local Croc config for an existing git project |
| [`workspace-create/`](workspace-create/) | Create a new editable repo, inline skill, and generated packet repo |
| [`workspace-clone-attach/`](workspace-clone-attach/) | Mix cloned and attached repos in one workspace |
| [`web-search/`](web-search/) | Enable SearXNG-backed web search |

## Running

Copy an example `croc.yaml` into a disposable directory or pass it with `--config`:

```bash
croc apply --config examples/workspace-create/croc.yaml
croc doctor --config examples/workspace-create/croc.yaml
```

Workspace examples create files relative to `--cwd` unless their paths are absolute.
