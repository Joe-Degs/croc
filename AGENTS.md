# Development Rules

## Style

- Match Pi's TypeScript style: ESM, Node16 module resolution, strict mode, erasable syntax only.
- Use tabs, Biome, and `tsgo` checks.
- Keep CLI parsing dependency-free unless a real need appears.
- No inline imports.
- No `any` unless the external API leaves no better option.
- Do not hardcode secrets. Reference environment variables instead.

## Commands

- After code changes, run `npm run check`.
- Do not commit unless explicitly asked.
- Hydrate dependencies with `npm install --ignore-scripts`.

## Shape

- Croc is a launcher/configurator. Taskplane remains the orchestration engine and Pi remains the coding agent.
- Keep tmux optional and profile-driven.
- Keep web search and diagnostics as configurable batteries, not required defaults.
