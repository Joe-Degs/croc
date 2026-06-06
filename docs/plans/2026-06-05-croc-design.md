# Croc Design

## Goal

Build a Pi-native launcher and profile manager around Taskplane, with optional batteries such as SearXNG web search, tmux wrapping, and dashboard control.

## Architecture

Croc is a TypeScript CLI. It writes project-local Pi and Taskplane config, starts the Taskplane dashboard, and launches Pi either directly or inside tmux. Taskplane remains the autonomous orchestration engine and Pi remains the coding agent.

Taskplane is bundled as a Croc npm dependency. Croc resolves `node_modules/taskplane` at runtime and writes that local path into Pi project settings, which makes the user-facing setup one Croc bootstrap instead of a separate Pi package install.

## Components

- CLI: command parsing and dispatch.
- Config: `croc.json` defaults and validation-light merging.
- Apply: writes `.pi/settings.json`, `.pi/taskplane-config.json`, and Taskplane dashboard preferences.
- Runtime: starts Pi with model/profile settings, optional tmux, and optional `/orch` startup target.
- Dashboard: starts/stops `taskplane dashboard` with a pidfile when not using tmux.
- Extension: registers Croc-managed Pi providers from `croc.json` when enabled.

## First Cut

The first implementation favors minimal working plumbing over a new orchestration layer. Croc does not fork Taskplane, does not change Taskplane's worktree behavior, and does not enable pi-lens by default.
