# Movie Night Croc Run Observability Log

Run: `20260605T135804`
Started: 2026-06-05
Workspace: `/Users/hubteluser/hubtel/movie-night-croc-test/.croc/workspace`
Dashboard: `http://localhost:8099`

## Expected behavior

- Taskplane should run from the Croc workspace root.
- Workers should edit only the execution repo named by `## Execution Target`.
- Workers should read generated `## Required Skills` files before implementation.
- Workers should use official docs when framework or CLI behavior is uncertain.
- Web tools should be available for live docs lookup through `web_search` and `web_fetch` when needed.
- Workers should record blockers or verification failures in `STATUS.md`.
- Verification should be Docker-first where possible.
- The UI should avoid gradients and left-accent cards.

## Observations

### 2026-06-05 14:00, launch health

- Dashboard initially failed because port `8099` was occupied by an old smoke dashboard process.
- Old process was `node /Users/hubteluser/hubtel/croc/node_modules/taskplane/dashboard/server.cjs --root /private/var/.../croc-taskplane-smoke --port 8099`.
- After stopping the old process, movie-night dashboard restarted cleanly with HTTP `200`.

Expected improvement:
- Croc dashboard startup should surface the failed dashboard stderr or detect port ownership before writing a stale PID.

### 2026-06-05 14:04, worker/task progress

- `TASK-001` is running in lane 1.
- `TASK-002` and `TASK-003` are blocked behind `TASK-001`, so `maxLanes: 2` will not fan out until wave 2.
- Worker worktree: `/Users/hubteluser/hubtel/movie-night-croc-test/.croc/workspace/repos/app/.worktrees/hubteluser-20260605T135804/lane-1`.
- Worker read the task prompt, status file, context, and required skill files.
- Worker has created two commits in the lane worktree:
  - `8d34cf7 feat(TASK-001): step 1 - scaffold TanStack Start app with shadcn/ui and movie-night UI shell`
  - `f4e11b2 feat(TASK-001): step 2 - add Dockerfile, docker-compose, Biome, scripts, .env.example, README`
- Worker is now in Step 3 verification.

Expected behavior met:
- Worker is operating in the correct app lane worktree.
- Worker is updating `STATUS.md`.
- Worker committed step-sized changes.

### 2026-06-05 14:05, docs and web-search usage

- The workspace installed `npm:@juicesharp/rpiv-web-tools` into `.pi/settings.json`.
- The installed package exposes `web_search` and `web_fetch` and uses `SEARXNG_URL` for SearXNG.
- Worker event log shows no `web_search`, `web_fetch`, SearXNG, or web-tool calls so far.
- Worker did inspect local CLI help using shell commands such as `npx shadcn@latest init --help`.
- Worker did not use Context7. That is expected because Context7 is available to this assistant, not necessarily to Taskplane workers.

Current hypothesis:
- Direct Croc-launched Pi sessions get the web-tools package, but Taskplane worker tool configuration is currently limited to file/bash/search shell tools. Workers likely cannot call `web_search`/`web_fetch` unless Taskplane worker tool allowlists include those tools or the package tools are otherwise exposed to worker Pi sessions.

Expected improvement:
- Croc should either add web tools to Taskplane worker/reviewer tool allowlists when `batteries.webSearch.enabled` is true, or the generated task prompt should explicitly say web search may not be available to workers and require shell/browser alternatives.
- Add an early smoke task or doctor check that verifies a worker can call `web_search` and `web_fetch`, not just that the package is installed.

### 2026-06-05 14:16, child-agent propagation patch

- Croc now writes `web_search` and `web_fetch` into generated worker, reviewer, and merge tool allowlists when `batteries.webSearch.enabled` is true.
- The local bundled Taskplane package now reads project/global Pi `packages`, `extensions`, and `skills` from settings for child agents.
- Taskplane child agents keep `--no-extensions` and `--no-skills`, but receive explicit `-e` and `--skill` flags from settings.
- A `jiti` smoke import of the patched Taskplane settings loader returned the expected movie-night resources: `npm:@juicesharp/rpiv-web-tools`, the Croc provider extension, `croc-workflow`, and the generated `.pi/skills` root.
- `croc apply` and `croc doctor` passed after regenerating the movie-night workspace config.

Remaining caveat:
- The Taskplane propagation patch is currently a local smoke-test shim under Croc's `node_modules/taskplane`, not a durable Croc source change or upstream Taskplane change.
- The currently running batch was started before this patch. Already-spawned lane processes will not pick it up; start a fresh batch or restart orchestration to test actual worker `web_search`/`web_fetch` calls.

### 2026-06-05 14:20, active batch progress after patch

- `TASK-001` is complete and `.DONE` was created.
- The same batch has advanced to `TASK-002` in lane 1.
- `TASK-002` is in Step 3 verification with data model, auth, and group-flow checkboxes complete.
- The `TASK-002` event log shows the worker read the required skill files from the prompt, but still has no `web_search` or `web_fetch` tool call.
- The worker process argv is not useful for checking the allowlist because the visible command is only `pi`.

Current decision:
- Do not kill the useful active batch just to prove the propagation patch. Use a fresh batch or tiny smoke packet when we need hard evidence that child agents can call web tools.

### 2026-06-05 14:58, wave 2 completion and merge behavior

- `TASK-002` completed successfully with SQLite schema, auth, sessions, and group flows.
- `TASK-003` completed successfully after worker iteration 2.
- Iteration 1 for `TASK-003` was killed at the context limit after 1184s and 90 tools; iteration 2 resumed at Step 3 verification.
- `TASK-003` worker exited with code `0`, created `.DONE`, and marked `STATUS.md` complete.
- Wave 2 merged one lane into `orch/hubteluser-20260605T135804` and reset the lane worktree for Wave 3.
- The base `main` branch in the app repo remains at the initial commit; Taskplane is accumulating work on the orchestration branch, not merging to `main` mid-run.
- `TASK-004` has started in Wave 3 on the same lane worktree.

Expected behavior met:
- Worker done marker and status propagation worked.
- Wave merge completed and downstream task unblocked.
- Worktree reset to the orchestration branch before the dependent task started.

### 2026-06-05 14:59, TASK-003 verification details

- Independent checks confirm the worker's verification report:
  - `npm run check` passed.
  - `npm run build` passed.
  - `npm run test` failed only because there are no test files.
- `STATUS.md` records the no-tests case as a blocker rather than hiding it.
- `TASK-003` added README instructions for setting `TMDB_API_KEY` and manually testing movie search/import flows.

Expected behavior met:
- Verification output was mostly recorded accurately.
- The worker did not claim tests passed when Vitest exited with code 1.

### 2026-06-05 15:00, Biome v2 generated-route lint workaround

- The generated TanStack route tree contains generated `as any` usage and tells consumers to exclude it from lint/format checks.
- The worker tried several invalid Biome ignore approaches before settling on a package-script workaround.
- Current `package.json` check script is `biome check --write $(find src -name '*.ts' -o -name '*.tsx' | grep -v routeTree.gen.ts)`.
- This passes locally, but it is shell-specific and not the cleanest Biome v2 configuration.
- Current Biome v2 docs/source indicate `files.includes` with negative patterns and `!!` force-ignore syntax replaced the old `files.ignore`/`linter.ignore` keys.

Expected improvement:
- The app scaffold should generate a Biome v2-native exclusion for `src/routeTree.gen.ts` instead of teaching workers to patch package scripts with shell pipelines.
- Croc or the generated frontend task skill should include a short note for TanStack Router generated files under Biome v2.

### 2026-06-05 15:01, web-search observation remains unproven

- No `web_search` or `web_fetch` tool call has appeared in worker events through `TASK-003` completion.
- `TASK-003` did read local TanStack Start skill/docs from `node_modules/@tanstack/react-start/skills/react-start/SKILL.md`.
- The active batch still cannot prove the local Taskplane propagation shim because it started before that shim was applied.

Current decision:
- Continue observing the useful run rather than interrupting `TASK-004`.
- Use a fresh tiny batch later to prove child-agent `web_search`/`web_fetch` and explicit `--skill` propagation.

### 2026-06-05 15:22, TASK-004 completion and checkpoint behavior

- `TASK-004` completed with `.DONE` created and worker exit code `0`.
- Step 1 added `movie_suggestions`, `suggestion_votes`, `watch_events`, and `reviews`, plus Drizzle migrations and server functions.
- Step 2 added the group queue route, movie suggestion flow, voting controls, watched state, and review form/list.
- Step 3 verification passed: migrations, `npm run check`, `npm run build`, and `npm run test`.
- Iteration 1 stopped via `.task-wrap-up` around 90% context after committing Step 2.
- Taskplane immediately started iteration 2 for Step 3 verification, avoiding a context-limit kill.
- Wave 3 merged into `orch/hubteluser-20260605T135804` and reset the lane worktree.
- `TASK-005` started in Wave 4.

Expected behavior met:
- Controlled checkpoint restart worked better than the earlier `TASK-003` context-limit kill.
- Worker fixed lint/build failures during verification instead of hiding them.
- Worker recorded verification notes in `STATUS.md`.

### 2026-06-05 15:23, TASK-004 quality observations

- `TASK-003` had added the `movies` schema without a migration; `TASK-004`'s first generated migration picked up `movies` along with the new workflow tables.
- `TASK-004` initially named client-callable server functions `suggestions.server.ts`, then verification hit TanStack Start import protection and renamed the file to `suggestions.ts`.
- The resulting `suggestions.ts` is client-importable and still imports `db`/schema at module top level; `vite build` passes, but this deserves a closer review against TanStack Start server-function bundling expectations.
- The worker added a shallow `schema.test.ts` and `vitest.config.ts`, turning `npm run test` from a no-test blocker into a passing six-test suite.
- The app still uses a fixed `currentUserId = 1` in prototype UI flows. Server functions still enforce group membership for that supplied user, but the UI is not wired to real session identity yet.
- `STATUS.md` temporarily showed top-level `✅ Complete` while Step 1/Step 2 were still in progress; Taskplane did not complete the task early because `.DONE` was absent.

Expected improvement:
- Add guidance for TanStack Start `createServerFn` files: client-importable server-function modules should not use `.server.ts`, and server-only dependencies should be handled in the proven pattern.
- Add prompt guidance to avoid marking top-level status complete before all steps are complete.
- Add a better testing expectation than "make Vitest non-empty"; tests should exercise meaningful behavior or explicitly document why only smoke/schema tests are feasible.

### 2026-06-05 15:43, TASK-005 and batch completion

- `TASK-005` completed successfully and `.DONE` was created.
- `TASK-005` iteration 1 stopped at the wrap-up checkpoint after Step 1 UI polish, then iteration 2 resumed with documentation and verification.
- Step 1 added empty/error state polish, a mobile hamburger header, About page content, and responsive layout improvements.
- Step 2 rewrote the README with environment setup, TMDB key notes, routes, scripts, Docker Compose commands, and troubleshooting.
- Step 3 attempted `docker compose up --build -d`; Docker daemon was unavailable through OrbStack's socket.
- Worker recorded the Docker blocker and ran local checks instead:
  - `npm run check` passed.
  - `npm run test` passed with 6 schema tests.
  - `npm run build` passed.
- All 5 tasks succeeded with zero skips and zero task failures.

Expected behavior met:
- Final task recorded the Docker blocker instead of pretending Docker verification passed.
- Controlled checkpoint/restart worked again for a long task.
- Batch progressed through all four waves and completed.

### 2026-06-05 15:44, automatic integration behavior

- After Wave 4 completed, the Taskplane supervisor ran `orch_integrate` from the live tmux session.
- The app repo's `main` branch was fast-forwarded to the orchestration result without a separate explicit user approval in this assistant conversation.
- The orchestration branch was cleaned up after integration.
- `main` is now at `0383417 feat(TASK-005): step 3 - fix useCallback deps in $groupId.tsx, verify check/test/build pass`.
- The app repo has one untracked runtime directory: `.pi/`.
- The packet repo still has uncommitted final task state despite the integration summary saying packet work was already integrated:
  - modified `taskplane-tasks/TASK-005-polish-ui-docs-and-docker-verification/STATUS.md`
  - untracked `taskplane-tasks/TASK-005-polish-ui-docs-and-docker-verification/.DONE`

Expected improvement:
- Croc should make integration policy explicit before starting a batch: auto-integrate, prompt-only, or leave on orchestration branch.
- If prompt-only, Croc/Taskplane should not run `orch_integrate` autonomously after a tmux/supervisor prompt.
- Croc should verify packet repo cleanliness after integration, not just app repo integration.

### 2026-06-05 15:45, integrated main verification

- Integrated `main` initially had no `node_modules`, so `npm run check`, `npm run test`, and `npm run build` failed with missing local binaries.
- After `npm ci`, all integrated-main local checks passed:
  - `npm run check` passed.
  - `npm run test` passed, 1 file, 6 tests.
  - `npm run build` passed, client and SSR.
- `docker compose config` passed and produced a valid Compose model, with a warning that `TMDB_API_KEY` was unset.
- `npm ci` reported 4 moderate vulnerabilities; no dependency changes were made during verification.
- Search of the built client output did not find `better-sqlite3`, `sqlite3`, `drizzle`, or the workflow table names, despite the client asset containing the server-function RPC surface.

Expected improvement:
- Final batch summaries should distinguish checks run in worker worktrees from checks rerun on the integrated target branch.
- Docker syntax validation can be run even when Docker daemon is unavailable, but container build/run still requires the daemon.

### 2026-06-05 15:46, web-tool final observation

- No `web_search` or `web_fetch` call appeared anywhere in the worker event log for `TASK-001` through `TASK-005`.
- The run therefore still does not prove Taskplane child-agent web-tool propagation.
- The active batch started before the local Taskplane propagation shim, so this run remains useful for behavior observation but not for proving the shim.

### 2026-06-05 16:54, human QA repair batch

- Human QA findings were appended as `TASK-006` in the same `croc.yaml`, not through a separate follow-up command.
- `croc doctor` saw 6 inline tasks after the YAML edit.
- `croc apply` materialized only the new packet files for `TASK-006` and skipped existing generated files.
- New packet path: `packets/taskplane-tasks/TASK-006-repair-movie-night-app-from-human-qa-findings`.
- `TASK-006` had `PROMPT.md` and `STATUS.md`, and no `.DONE`, before orchestration started.
- Sending `/orch all` into the existing Pi session produced a fresh batch, not a resume:
  - batch `20260605T165415`
  - pending tasks: 1
  - completed tasks: 5
  - wave plan: `[["TASK-006"]]`
- `batch-state.json` showed only `TASK-006` in the active wave and only one app lane worktree.
- `dependencies.json` was regenerated with only the active pending graph for `TASK-006 -> TASK-001..TASK-005`; completed task graph entries were not preserved in that file.
- `TASK-006` completed successfully and was integrated into app `main` as `c3eb6d7 feat(TASK-006): fix .validator → .inputValidator API across all server functions`.

Expected behavior met:
- The same YAML-driven workflow works for post-human-test repair.
- Completed `.DONE` tasks were skipped by discovery.
- A newly appended task was enough to kick off a new repair batch.

Observed gaps:
- Existing-session startup was clunky because `croc start all` did not inject `/orch all` when the tmux session already existed, forcing manual `tmux send-keys` during the experiment.
- Worker/supervisor commands printed `.env` while starting the app for testing, exposing `TMDB_API_KEY` in the session transcript. Rotate the key if the transcript is sensitive.
- The repair task fixed the reported `createServerFn(...).validator` runtime error, but human retesting still needs to verify the full app flow.
- Post-repair app logs still show `/groups/$groupId` failing because `Route.params` is undefined in `src/routes/groups/$groupId.tsx`. This should become a follow-up app repair task rather than a manual assistant patch.
- `TASK-006` notes also recorded missing `/sign-up` and `/login` UI routes despite auth server functions existing.
- Docker build still fails because `npm ci` inside the Docker image sees a lockfile/package mismatch under the image's npm version.

### 2026-06-05 17:10, Croc existing-session start fix

- Croc `src/core/runtime.ts` was updated so `croc start <target>` can dispatch `/orch <target>` into an existing tmux-backed Pi session.
- If `.pi/batch-state.json` reports an active phase, Croc prints the active batch and does not dispatch another `/orch` command.
- A throwaway tmux session test confirmed Croc now sends `/orch all` internally and prints the attach command, without requiring users to run `tmux send-keys`.
- A second throwaway tmux session with fake `batch-state.json` confirmed Croc does not dispatch `/orch all` when a batch is already `executing`.
- Repro during the focused follow-up batch: running `croc start all` from this non-interactive assistant shell successfully dispatched `/orch all` to `croc-movie-night`, then still printed `open terminal failed: not a terminal` while attempting to attach.
- `npm run check` passed.
- `npm run build` passed.

Expected improvement:
- Users should be able to keep iterating through `croc.yaml` and rerun `croc start all`; Croc should handle tmux session reuse internally.
- Croc should detect non-TTY execution before attempting tmux attach. In non-TTY mode, it should print the attach command and exit cleanly after dispatch instead of surfacing `open terminal failed: not a terminal`.

### 2026-06-05 19:43, TASK-007 autopsy and split decision

- `TASK-007` attempted to add Playwright smoke tests and repair all broken app flows in one lane.
- The task ran for about 90 minutes and ended skipped with zero succeeded tasks.
- The worker hit the context limit seven times before getting stable E2E signal.
- Iterations 8 through 10 produced useful partial progress, including a saved branch with three partial commits:
  - `saved/hubteluser-app-TASK-007-20260605T181152`
- The best E2E signal reached during the task was 6 passing and 6 failing tests.
- Failure modes included stale Vite servers on port 3000, `networkidle` waits hanging under Vite/HMR, invalid E2E seed imports, selector strict-mode failures, server-function call-shape errors, group queue loading forever, and unsafe process/secret handling attempts.
- Taskplane recorded partial progress as source changes even when no STATUS checkboxes advanced, so the worker avoided stall classification while still failing to complete the task.
- The old `TASK-007` packet was explicitly superseded and given a `.DONE` marker so fresh discovery does not rerun the broad repair loop.
- While materializing the split, `croc apply` created a new folder for renamed `TASK-007` (`TASK-007-superseded-broad-e2e-repair-attempt`) but left the old generated packet folder (`TASK-007-add-end-to-end-smoke-tests-and-self-repair-broken-app-flows`) in place.
- That produced two packet folders with the same task id until the stale old packet files were removed manually.
- This is a Croc workflow bug: generated packet reconciliation handles unchanged/existing files but does not safely retire or archive stale generated folders when an inline task title changes.
- `croc.yaml` now splits the work into focused follow-up tasks:
  - `TASK-008`: isolated Playwright E2E harness
  - `TASK-009`: server-function call shapes and TMDB E2E flow
  - `TASK-010`: auth routes and auth E2E flow
  - `TASK-011`: group route and group management E2E flow
  - `TASK-012`: queue actions and review E2E flow
  - `TASK-013`: Docker install and build verification
  - `TASK-014`: final E2E proof table and regression verification
- Each focused task includes E2E cleanup instructions where relevant: reset the dedicated E2E database, close SQLite handles, let Playwright own app startup, avoid `networkidle`, clean only confirmed stale port 3000 listeners, and do not print `.env` or `TMDB_API_KEY`.

Expected improvement:
- Taskplane should distinguish uncommitted source churn from durable progress when no task checkboxes advance.
- Large browser-repair prompts should be split by failure class before dispatch.
- Croc or Taskplane should provide a safe port-cleanup and E2E database-reset convention for web app tasks.
- `croc apply` should detect stale generated packet folders, especially duplicate task ids caused by title/slug changes, then warn, archive, or remove them according to a clear policy.

### 2026-06-05 14:06, shadcn CLI behavior

- Worker hit interactive shadcn CLI prompts despite trying non-interactive flags.
- Worker tried piped input and an `expect` script before switching to manual `components.json` and `cn` utility setup.
- Worker then used `npx shadcn@latest add ... -y`, which appears to work for component installation.

Expected behavior partly met:
- Worker did not hang permanently.
- Worker investigated CLI options and found a reliable workaround.

Expected improvement:
- Future task prompt should say: if `shadcn init` is interactive, do not spend many attempts on stdin hacks; inspect `init --help` once, then manually create config or use the documented non-interactive flags known to work.
- Add a Croc skill note for shadcn TanStack Start setup quirks from this run.

### 2026-06-05 14:07, verification and Docker behavior

- Worker is running local `npx biome check --write src/` during verification.
- Prompt expected Docker-first verification where possible.
- README includes Docker Compose commands, but also includes local npm development commands.

Expected behavior partly met:
- Local verification is useful during scaffold.
- Final verification should still run through Docker Compose or record why it cannot.

Expected improvement:
- Strengthen generated prompts to distinguish scaffold-time `npx` from final verification.
- Require final `STATUS.md` to list exact commands run and whether each was local or Docker-based.

### 2026-06-05 14:08, TASK-001 verification results

- Worker reported Biome check passed after fixing `biome.json` and JSX lint handling.
- Worker reported `npm run build` passed.
- Worker reported `npm run test` found no test files, expected for the scaffold task.
- Worker reported `npm run db:migrate` ran the placeholder migration command.
- Worker attempted `docker compose build` and found Docker daemon unavailable on this machine.
- Worker recorded the Docker issue in `STATUS.md` rather than hiding it.

Expected behavior met:
- Verification failures were not hidden.
- Environment limitation was recorded separately from code success.

Expected improvement:
- Croc should have a preflight check for Docker availability when task packets require Docker-first verification.
- If Docker is unavailable, Croc could mark it in generated context before workers spend time trying Docker commands.

### 2026-06-06, vendored Taskplane child-agent resource propagation

- Croc now vendors Taskplane under `packages/taskplane` as a git subtree and resolves the bundled package from source checkouts.
- The Croc-local Taskplane patch reads Pi `packages`, explicit `extensions`, and `skills` from project/global settings, then forwards them to worker, reviewer, and merge child agents.
- Relative extension/skill paths are rebased from their settings directory before forwarding, and filtered package objects are not expanded into unfiltered package extension flags.
- Child agents still run with `--no-extensions` and `--no-skills`, but now receive explicit `-e` and `--skill` flags for configured resources.
- Croc now removes stale generated Taskplane package and provider extension paths from `.pi/settings.json` before adding the current bundled paths, so running from a worktree does not leave old Croc-root resources alongside current ones.
- A disposable fake-Pi E2E proved project/global resource merging, dedupe, exclusions, package object sources, and worker/reviewer/merge forwarding through real Croc and Taskplane runtime entrypoints.
- A disposable real-Pi E2E using global Pi config proved worker, reviewer, and merge child agents loaded a project-local probe extension and skill.
- The real-Pi probe confirmed worker/reviewer/merge model inheritance: each child argv had no `--model` flag, while Croc keeps the supervisor model explicit.
- Croc now defaults `taskplane.workerModel` to empty and generated Taskplane config no longer falls back to `pi.model` for the worker.
- Root Croc regression coverage now asserts the generated config leaves worker, reviewer, and merge models empty while pinning supervisor to `hubtel/grm-2.6-plus`.

Verification:
- Root `npm test` passed.
- Root `npm run check` passed.
- Root `npm run build` passed.
- Movie Night `croc doctor` passed.
- Taskplane focused resource/timeout tests passed earlier in the patch cycle.

### 2026-06-06, real worker web_search proof

- Created a disposable real Croc project at `/var/folders/_9/345_2pfn4ml4pwgdf0zmhsvm0000gp/T/opencode/croc-real-web-search-worker-20260606` using a normal `croc.yaml`, tmux runtime, workspace-create repo, and `batteries.webSearch.enabled: true`.
- Ran `croc apply`, `croc doctor`, and `croc start all` from the Croc worktree, using the real global Pi model/provider config under `~/.pi/agent`.
- Generated Taskplane config gave the worker `read,write,edit,bash,grep,find,ls,web_search,web_fetch` and left worker/reviewer/merge models empty for inheritance.
- Parent Pi startup loaded `@juicesharp/rpiv-web-tools`, `provider.js`, and `task-orchestrator.ts`; model display showed Worker/Reviewer/Merger inherit to `hubtel/grm-2.6-plus`.
- The actual worker event log recorded a real `tool_call` for `web_search` with query `official Kubernetes documentation home page`, followed by a `tool_result` for `web_search`.
- The worker created `web-search-proof.md` on `orch/hubteluser-20260606T030729` with `https://kubernetes.io/docs/home/` and the required sentence `web_search was used by this worker`.
- Batch `20260606T030729` completed successfully with 1/1 tasks succeeded and 0 failures/skips/blocks.
- The disposable tmux session `croc-real-web-search-worker-20260606` was stopped after proof collection to prevent extra supervisor actions.

## Current risks

- Web search is configured for future Taskplane workers and child-agent resource propagation is proved by synthetic probes, but the completed Movie Night batch did not include an actual `web_search`/`web_fetch` call.
- Docker build/run remains unverified because the Docker daemon was unavailable; only local npm checks and `docker compose config` were verified after integration.
- Dashboard stale PID handling hides root-cause stderr.
- Worker used several shell truncation helpers (`tail`, `head`) in commands; acceptable for Taskplane worker today, but it means event logs hide full command output.
- Worker also used shell discovery/filtering helpers (`find`, `grep`) inside `package.json`; that is less portable than a native Biome v2 config exclusion.
- App runtime auth is still prototype-like in several UI flows because `currentUserId` is hardcoded.
- `suggestions.ts` passes build but still needs review for top-level DB imports in client-importable `createServerFn` modules.
- Taskplane auto-integrated the final orchestration branch into `main`; this needs an explicit Croc policy knob.
- Packet repo has leftover final `TASK-005` status and `.DONE` changes after integration cleanup.

## Follow-up improvements for Croc

- Add dashboard log file capture for stdout/stderr.
- Add dashboard port ownership diagnostics before start.
- Add web-tool worker availability check to `croc doctor` or a generated smoke packet.
- Decide whether to upstream the Croc-local Taskplane child-agent resource propagation patch.
- Add first-class `docs` references in Croc work packets with explicit allowed lookup mechanisms.
- Add a generated observability checklist for each Croc run.
- Add TanStack Router/Biome v2 generated-route guidance to the frontend or Croc workflow skill.
- Add TanStack Start server-function module naming/import-boundary guidance to generated skills.
- Add an integration policy setting for Taskplane batches and expose it in Croc status/logging.
- Add generated packet reconciliation to `croc apply`: detect duplicate task ids across packet folders and stale generated folders after task title/slug changes, then archive/remove them or fail loudly before orchestration starts.
- Fix non-TTY `croc start all` attach behavior: if dispatch succeeds but stdout/stderr is not a terminal, skip `tmux attach`, print `tmux attach -t <session>`, and return success.
