# Changelog

All notable Croc changes are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-06-19

### Added

- Added Taskplane CLI history, mailbox, replies, tell, and broadcast commands for inspecting persisted batches and steering active agents.
- Added Croc Taskplane live controls for pausing, resuming, aborting, and starting targeted batches from the `croc taskplane` namespace.
- Added command-specific help for Croc and bundled Taskplane CLI commands.

### Changed

- Prevented Croc from dispatching a new Taskplane start target into an existing tmux session while an active batch is already running.

### Fixed

- Fixed spawned Taskplane workers, reviewers, and merge agents loading Pi-managed npm package extensions by resolving launch-time package specs to installed package roots while preserving config package source strings.
- Fixed engine-worker IPC, process error, and exit failure persistence so failures preserve existing task graph, wave plan, diagnostics, and segment state.

## [0.3.0] - 2026-06-15

### Added

- Added `taskplane.compactionKillPolicy` with `immediate` and `defer` modes.
- Added deferred Taskplane context-kill behavior so workers can wait for Pi compaction before Taskplane terminates a high-context session.
- Added Taskplane configuration, schema, docs, and settings TUI support for `compactionKillPolicy`.
- Added Croc battery contribution wiring so enabled batteries can add packages and Taskplane tool allowlist entries from one place.
- Added Taskplane worker, reviewer, and merge allowlist support for `headroom_retrieve` when the Headroom CCR bridge is enabled.

### Changed

- Threaded Taskplane Runtime V2 context settings through normal execution, retry, resume, reconnect, and merge-related paths.
- Updated Croc-generated Taskplane config to include the configured compaction kill policy.
- Improved Taskplane context telemetry handling around compaction lifecycle events.
- Bundled Taskplane now reports omitted agent models as `default model` instead of rendering `[Undefined]`.

### Fixed

- Fixed Headroom CCR retrieval in Taskplane workers by exposing `headroom_retrieve` in generated agent tool allowlists.
- Fixed deferred context handling so successful compaction clears a pending Taskplane kill and failed, skipped, or aborted compaction still allows Taskplane to enforce the kill threshold.
- Fixed non-finite context telemetry handling so invalid context values are ignored.

## [0.2.2] - 2026-06-12

### Added

- Added Headroom as an optional Croc battery, including managed proxy startup, readiness checks, routed Pi provider base URLs, and local CCR retrieval bridge support.
- Added `croc taskplane` commands for running bundled Taskplane status, summary, and integrate actions through the Croc runtime context.
- Added release validation for packaged docs and examples.
- Added `examples/rate-limiter-task-with-headroom/`, a copy/adapt task packet example for running a Redis rate limiter workload through Headroom.
- Added a guided local release script that prepares version commits and tags without pushing.

### Changed

- Documented Headroom configuration, OpenAI-compatible provider routing, CCR bridge behavior, and release workflow expectations.
- Expanded example guidance with a general apply, start, dashboard, status, summary, and integrate flow.
- Improved Taskplane dashboard and runtime event handling for worker feed visibility during Croc-managed runs.

### Fixed

- Kept `croc apply` offline for Headroom configs so apply validates and writes runtime files without starting or checking the proxy.
- Made `croc start` wait for Headroom readiness before launching the dashboard and Pi.
- Redacted sensitive provider and Headroom config values from Croc command and tool output.
