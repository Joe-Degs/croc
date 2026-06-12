# Changelog

All notable Croc changes are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
