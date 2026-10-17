# Changelog

## 0.1.8 (2026-10-16)

### Added

- An opt-in, read-only operator dashboard (`dashboard`, off by default; [operations](docs/operations.md#operator-dashboard), [design](docs/design.md#operator-dashboard), [security](docs/security.md#the-operator-dashboard)). `serve` runs it on a loopback listener of its own (default `127.0.0.1:3791`, never the MCP port), to be published with a tailnet-only proxy on a path (`dashboard.basePath`). Views: an overview (what needs you, vital signs, an agents → gateway → hosts map, recent activity), hosts (last check with its time, engine backoff, credential and renewal, capacity, policy and projects), clients (authorization separated from observed MCP and refresh successes; unknown stays unknown), jobs (waiting or recent, open, finished, with T3 thread links and a code-only activity log) and checks. It controls nothing: approvals and job control stay in T3.
- **Run checks**, on demand only: a fresh `t3_environment_read` per host, the public URL's metadata, that the public URL does not serve the dashboard, the database quick check, data directory permissions, credential state and the mint executable's resolution. Nothing is enrolled, renewed or executed.
- `doctor`, with the dashboard enabled, checks that it answers on its listener and that the public URL does not serve it (`dashboard exposure`).
- `hosts[].transportNote` (a descriptive label such as "SSH tunnel", shown on the dashboard and never checked) and `dashboard.clientLabels` (display names for client ids).
- `npm run dashboard:demo`: the dashboard on a synthetic fleet (a real gateway with temporary data, fake T3 hosts on loopback, the fictional clients Grok Bot, Muse and Notion) in five scenarios, for screenshots and browser checks.

### Security

- No login, session, cookie or browser storage: the network (loopback plus a tailnet-only proxy) is the boundary, and the page holds no secret. Requests with an unexpected `Host` get `421` (DNS rebinding); requests Tailscale marks as Funnel traffic get `403`; API requests need a custom header and refuse cross-site fetch metadata and foreign origins; responses carry a strict CSP without inline script or style, `frame-ancestors 'none'` and CORP. The page builds its DOM without HTML parsing and links only to its own views and `t3-thread://v1/<id>` (built from validated thread ids).
- The dashboard shows no tokens, hashes, codes, T3 credentials, the server key, mint commands or their output, task text, replies, questions, options, answers, delegated task titles or catalogs, and errors only as codes with fixed text. Opening it never contacts T3.

### Compatibility

- No migration and no change to OAuth, MCP, tools, grants or the job engine's behavior. The engine and host registry gain read-only accessors (`JobEngine.status()`, `HostRegistry.lastHealth()`), the job store two read queries, and `doctor`'s public URL check shares its probe with the dashboard. Existing configs are valid unchanged.
- Covered by synthetic tests: `test/dashboard.test.ts` (configuration, listener isolation both ways, Host/Funnel/Origin/fetch-metadata/content-type handling, headers, base paths, honest host states including outage, refusal, not enrolled and engine backoff, clients with expired, revoked, replayed and never-observed grants, jobs and attention, privacy of content and secrets in responses and logs, bounds, read-only checks, exposure through a misdirected tunnel), `test/dashboard-ui.test.ts` (hostile text in every view, unsafe links dropped, no HTML-parsing APIs) and `test/dashboard-demo.test.ts` (four demo scenarios end to end). No live deployment is claimed here.

## 0.1.7 (2026-10-16)

### Fixed

- The configured non-mutating `mintPairingCodeProbe` has a ten-second deadline instead of two. The deployed macOS service runs as a launchd agent with `ProcessType` Background, which schedules its children at a lower priority: the configured T3 version probe, which answers in about half a second in the foreground, was measured at just over two seconds there, so startup logged `probe_timeout` while foreground `doctor` passed ([evidence](docs/evidence/startup-probe.md)). Output budgets, the exact configured argv, executable resolution, startup independence, abort on shutdown and the non-mutating-only rule are unchanged; a hung probe can now hold the first renewal pass or a `doctor` host check for up to ten seconds. No launchd template or configuration change.

### Added

- Opt-in discovery of T3 projects and model capabilities per host (`hosts[].discovery`, all off by default; [issue #12](https://github.com/boundsj/t3-fleet-gateway/issues/12)). With `enabled`, agents with Read access on the host get two read-only tools: `fleet_projects` (T3 project ids and names, with the launch policy that applies to each and how to start work there) and `fleet_models` (provider instances, models and their advertised options such as a reasoning effort, including providers with no models, with T3's child-task flags and constraints as metadata). Catalogs are read from T3 on demand, kept for 30 seconds, shared between concurrent readers, refreshed with `refresh: true`, paged per host with cursors bound to one read by a random snapshot id (an old cursor is refused after a refresh, the TTL or a restart), and bounded (2,000 projects; 100 providers, 2,000 models, 64 options per model, 256 choices per option): a catalog beyond a bound is reported unavailable, never cut. Unavailable or disabled hosts never hide the others. Text output carries every id and choice for clients that read only text.
- `work_start` accepts, besides a configured `project` alias, a `target: { host, projectId }` from `fleet_projects` and an optional `modelSelection: { instanceId, model, options? }` from `fleet_models`. A target that exactly one configured alias maps to is launched as that alias with all of its settings (`allowWorkStart: false` still refuses); several matching aliases or an ambiguous title mapping require the alias; a project with no alias follows the host's discovery policy (`runtimeMode`, `baseRef`, `branchPrefix`) and needs `discovery.allowWorkStart`. The project list is read from the host at that moment, never from the browse cache, so a project renamed after an agent browsed is classified under its current title, and the policy is checked again right before the launch (`launch_policy_changed` fails a queued job whose project has since been renamed into a configured title or lost its launch permission). An explicit selection must match the host's freshly read catalog exactly (`false` is preserved for boolean options) and is checked again right before the launch; otherwise it is refused and nothing is started or substituted. `target` and `modelSelection` are strict objects: an unknown field such as `reasoningEffort` outside `options` is refused with no job, never dropped. Omitting it keeps the whole configured default (project, then host, then the T3 project default). What such a job resolved to is recorded with it (`jobs.launch_spec`, append-only migration 8); alias-only jobs dispatch exactly as before and their request-id hashes are unchanged.
- Job views add `projectId`, `projectName`, `source` and `model`; feed events add `host` and `projectId`; `work_list` filters by `target`; `fleet_status` hosts show their `discovery` flags. New error codes `discovery_disabled` and `catalog_limit`; the dispatcher's `model_selection_invalid` and `launch_policy_changed` failures.
- The developer compatibility check now covers `orchestrator_capabilities` (twelve consumed tools).

### Compatibility

- No change for existing configurations: discovery is off unless `hosts[].discovery.enabled` is set, and the host must separately set `discovery.allowWorkStart` before any launch into an unconfigured project. Existing grants, aliases, defaults, request ids and queued jobs behave as before. Migration 8 adds one nullable column.
- Covered by synthetic two-host tests (`test/discovery.test.ts`): opt-out, same-named projects on two hosts, restricted and read-only grants, an unavailable host, browse-only hosts, alias bypass attempts, selections and defaults, idempotency, restart, pre-dispatch failures, lost launches, paging, cache, cursor identity across a restart, strict selection input, title renames after browsing and privacy. A bounded isolated smoke against one fresh QA-only T3 instance passed 28 of 28 checks at both the initial head and the implementation with review fixes ([docs/evidence/discovery.md](docs/evidence/discovery.md)). That is not a live fleet, production or hosted-connector (Grok, Notion) qualification.

## 0.1.6 (2026-10-15)

### Fixed

- T3 thread responses no longer have to include `link`. Current launch, list and read responses are normalized to the documented `t3-thread://v1/<threadId>` URL without encoding the opaque id. Older supplied links and existing job links remain supported. This restores watcher reads, launch reconciliation, standing-job adoption and message reads against current T3, without relaxing other required response fields or retrying launches.
- A valid watcher observation clears a previous `t3_invalid_response` error, so recovered jobs no longer retain the stale schema failure. Genuine run failures keep their existing clearing rules.

No database migration or configuration change.

## 0.1.5 (2026-10-13)

### Added

- Per-machine authorization. The approval page offers All machines (the fleet scopes: every host, including hosts added later) or Selected machines (`host:<id>:read` / `host:<id>:operate` for the ticked hosts only), and `clients token --hosts mini,macbook` (or `--hosts all`, the default) does the same for bearer tokens. Every tool enforces the hosts: `fleet_status`, `work_list`, `work_feed` events and attention show only permitted hosts (filtered before limits); direct job tools answer a job elsewhere as an unknown id, and `work_start` checks both the project's host and the host of a replayed request's job. Empty, malformed or unknown selections are refused before an approval code is spent or a token is stored. A refused approval page, including after a wrong approval code, is shown again with the machines and access the operator chose, never the request's defaults.
- `clients list` and `clients diagnose` show granted access per host.

### Compatibility

- No schema migration. Grants, refresh tokens and bearer tokens issued before 0.1.5 keep their fleet-wide access, including hosts added later, with no reauthorization. Metadata still advertises only the fleet scopes. Refresh can keep or narrow a restricted grant, never widen it; a refresh that asks for the generic fleet scopes keeps the grant's own hosts.
- `clients list` shows fleet-wide access as `operate (all hosts)` / `read (all hosts)`, and `clients token` names the hosts it covers.

Covered by synthetic two-host tests through the public OAuth, MCP and CLI interfaces. No live multi-host qualification is claimed.

## 0.1.4 (2026-10-12)

### Fixed

- T3FG-11, found during T3FG-3 supervised live QA: accept T3-owned opaque pending request IDs unchanged in `work_respond` and targeted `work_status`. Real Codex IDs exceed the previous 200-character limit. Job/request membership, non-empty validation and the separate question-id, answer-size and idempotency-key limits remain enforced. Public text-only regressions reproduce both failures before the fix; the original real question resumes successfully after it.

- T3FG-12: a transient T3 `waiting` status with zero pending requests no longer invents a permission approval. Actual questions and positive pending counts still produce `needs_input`. The native sample predates this state-rule fix; its synthetic regression fails before the fix and passes after it, and real v0.1.4 question resumption after the fix showed no false approval. Subsequent operator approval retests completed on both isolated and production v0.1.4 gateways, with exact scratch markers and cleared approval flags.

### Changed

- Restore the prepared expanded opt-in lifecycle script: tool discovery, `work_list`, full `work_messages` reads and explicit successful-tool coverage. An explicit scratch project alias is required.
- Document the supervised run from the v0.1.3 baseline through the fix builds and the authorized v0.1.4 deployment: lifecycle, isolated runtime failure, standing-job reuse, delegated child/parent resumption, SDK outage recovery and a lost start response. v0.1.4 question, lifecycle and operator approval retests passed; a direct HTTP client using only content text passed the isolated question/messages/feed check, and Grok Bot confirmed reading the production question/options as plain text and answering with the full 228-character request ID through its connector registered as Cursor. Owned QA jobs and temporary runtime/access were cleaned up; original production settings were restored and doctor passed. An actual Notion Custom Agent's existing MCP connection passed a production v0.1.3 fleet check; T3FG-3 is complete under the agreed shared-contract/connectivity scope. A separate Notion job workflow and hosted-client recovery remain optional, unrun coverage.

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## 0.1.3 (2026-10-12)

### Added

- T3FG-5: offline `clients diagnose <id>` reports OAuth versus static bearer clients, usable access/refresh grants, expiry ranges, rotation/grace/supersession/replay states, and each family's revocation reason. Aggregate usability considers every family, while explicitly leaving operator/cloud route reachability and the connector's saved token unknown.
- Separate successful MCP and refresh timestamps (append-only migration 7). Old mixed last-use data remains intact; new times start unknown. Completed authorized MCP HTTP 2xx exchanges are sampled once per minute; successful refresh pair issuance, including grace retries, is recorded transactionally on every success.
- Synthetic SDK outage recovery regression: saved credentials and feed cursor survive ingress loss across access expiry, automatically refresh on reconnection, and resume without duplicate events or work. This recovery already passed on the pinned v0.1.2 implementation; the new diagnostic CLI was missing there.
- Recovery instructions distinguish ingress, gateway authentication, downstream T3 credentials, and disabled connector routines. Installed SDK retry limits are documented; real Grok and Notion retry behavior remains unverified.

### Changed

- `clients list` labels OAuth families as `unrevoked` rather than inferring active authentication from their count; use `diagnose` for grant usability.

T3FG-1 remains blocked on the monitoring decision. T3FG-3/full live QA remains deferred; no new live verification, deployment, or publishing is claimed.

## 0.1.2 (2026-10-12)

### Fixed

- T3FG-2: `work_status` text now includes pending request and question ids, headers, question text, every option label/description/value, selection rules and answer constraints. Clients that consume only MCP text can answer with `work_respond`. `allowCustomAnswer`, `required` and `multiSelect` preserve true/false, with null for null or absent T3 flags. Unreadable questions remain explicitly temporarily unreadable.
- Pending questions are bounded without partial actionable data: at most five requests read by default; `pendingRequestId` selects another. A request exceeding 50 questions, 100 options per question or 64,000 JSON characters returns `questions: null` and `questionsUnavailable: "too_large"`, directing the operator to T3. `read_limit` and `temporarily_unreadable` explain other null results. `work_cancel` text points to `work_status` before answering a still-pending question.
- Unspecified question flags retain honest nulls while text provides an answer path: follow explicit wording, and without instructions to select several try a single listed value as a conservative attempt. T3 validation remains authoritative; omitted/null flags alone do not require escalation.
- Automatic renewal starts after all startup preflight checks settle, including an unexpected rejection, unless shutdown has begun. Rejections produce fixed diagnostics; logger errors still propagate and known executable failures still gate each host's renewal.
- Probe cancellation explicitly force-kills the direct child, including probes that ignore SIGTERM on Node 26.0. Startup preflight never initiates or awaits health reads, so stalled MCP initialization cannot delay shutdown through preflight; doctor still compares fresh health.
- T3FG-4: `doctor` and `serve` startup preflight the mint executable in their own process environment, diagnose missing/non-executable commands and version-pinned paths, and distinguish known failure from unverified checks. Known executable failures stop automatic renewal before pairing registration while retaining the old credential.

### Added

- Optional `hosts[].mintPairingCodeProbe`: exact argv for an explicitly operator-configured non-mutating probe. No mint command or guessed `--version` is executed as preflight. Probes time out after two seconds, cap stdout/stderr at 4,096 bytes each, and are aborted on shutdown without being awaited. A bare version, exact native `t3 v<semver>` output or JSON `{"version":"x.y.z"}` enables comparison with the T3 server; disagreement is a warning, not an incompatibility verdict.
- Synthetic public MCP and CLI regressions, question-limit/nullable-flag coverage, PATH/probe/startup/shutdown checks and logging/event leakage checks. Command diagnostics contain no raw stdout/stderr, argv or executable paths; enrollment no longer echoes command argv.

No database migration. This release covers T3FG-2 and T3FG-4 only. T3FG-1 remains blocked on the monitoring decision; T3FG-3/full live QA remains deferred until the operator is available. No new live QA is claimed.

## 0.1.1 (2026-10-09)

### Added

- `deploy/launchd/install.sh` warns when `T3_BIN` (by default `command -v t3`) is inside one T3 version's directory (`.../runtime/versions/<version>/`). After T3 updates itself, a service `PATH` holding that directory keeps running the old `t3` for credential renewal, and renewal fails with `pairing_command_failed` if the directory is removed.
- docs/operations.md, "A t3 that follows T3's updates": why, and a wrapper that runs the version T3's service uses. The README's Setup section and the systemd unit point to it.

## 0.1.0 (2026-10-08)

### Added

- Agent-facing MCP server on `/mcp` (Streamable HTTP, stateless, JSON responses) that serves both 2025-era and 2026-07-28 clients and accepts requests without `MCP-Protocol-Version`.
- OAuth 2.1 authorization server: metadata, dynamic registration for public clients, an approval page gated by one-time codes minted with `pair` (Read or Operate), PKCE S256, rotating refresh tokens with replay detection and a retry grace window, idle expiry, and per-client revocation.
- Downstream T3 Code client per host, with enrollment through T3's pairing-code approval, verified credential storage, and automatic renewal before the 30-day expiry.
- `fleet_status` tool.
- CLI: `serve`, `pair`, `clients list|revoke`, `hosts enroll|status`, `jobs adopt|list|release`, `doctor`.
- SQLite storage with versioned migrations, including the tables for the job layer.
- launchd installer and systemd user unit.
- Job layer: `work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list` and `work_feed`. Jobs run as T3 threads titled `[job:<id>]` in fresh worktrees on `<branchPrefix><id>`, with a durable ledger and append-only event feed, request-id idempotency, a per-host FIFO dispatcher that respects `maxConcurrentJobs`, a watcher that derives `running`, `needs_input`, `idle` and `failed` from T3 thread reads, host backoff that never changes job state (a slow launch makes only that job `unknown`; a T3 error about one job is recorded on that job and never stalls the others), reconciliation of launches whose outcome was lost or that T3 answered with an error that may leave a thread (by the title marker at the end of the title, in unsettled and settled threads, never relaunched; `launch_not_confirmed` after `watcher.reconcileWindowMinutes`), and cancels that keep interrupting each run that starts on the thread until it stops (one T3 `clientRequestId` per run). A found thread on which no run ever started fails the job with `launch_not_started` (keeping the thread's id and link) instead of reporting a finished turn; any failed lookup after a launch error leaves the job `unknown`; a search match T3 refuses to read is skipped.
- T3 client wrappers for the thread and pending-request tools, and transport errors that say whether T3 may have received the call (`T3TransportError.delivery`; new error code `t3_response_lost`).
- Every job view carries `stateChangedAt` (when the job entered its current state; the feed's attention window and order use it) and `updatedAt` (the last real change, including the host-unreachable mark, not the last poll).
- Every job view carries `link`, which opens the job's thread in the T3 app, from the launch result on.
- Error codes `job_state_conflict` and `request_id_conflict`.
- Config: `watcher.reconcileWindowMinutes`; `hosts[].defaultModelSelection`, the model for projects on that host that set no `modelSelection` (T3 refuses launches without a model when the T3 project has no default). `doctor` fails a project that would have no model, `serve` logs `project.model_missing` at startup (in the background: shutdown does not wait for it, and a host that fails is not asked again for its other projects), and `fleet_status` shows each project's `runtimeMode` and `modelConfigured`.
- `config.example.json` enrolls its host with `access: "full-access"`: the host's access is only a ceiling, and each project's `runtimeMode` (default `approval-required`) is what limits a job.
- `scripts/e2e-live.ts`: a live end-to-end check against a running gateway and a real T3 host (`npm run e2e:live`), outside the test suite. If the job it cancels has already finished, it starts one replacement and cancels that.
- Standing jobs: `t3-fleet-gateway jobs adopt <project> <threadId> [--title <text>]` registers an existing T3 thread (for example a long-running coordinator thread) as a job agents drive with `work_continue`, `work_respond`, `work_feed` and `work_status`. The thread must belong to the project's T3 project; its state is read at adoption and its history is not replayed. Standing jobs hold no concurrency slot, a failed run leaves them `idle`, `work_cancel` interrupts their current turn only (new outcomes `interrupt_requested` and `not_running`; new event `interrupt_requested`), and `jobs release <jobId>` ends one in the new terminal state `released` without touching T3. Every job view has `standing`.
- Config: `projects[].allowWorkStart` (default `true`). When `false`, `work_start` in the project fails with the new error code `start_disabled`, whose message names the project's standing jobs and says to use `work_continue`. `fleet_status` shows each project's `allowWorkStart` and its open `standingJobs` (job id, title, state, link), and the `fleet_status`, `work_start` and `work_continue` descriptions tell agents to drive a project's coordinator with `work_continue` and follow it with `work_feed` and `work_status`.
- `work_cancel` on a standing job with nothing running returns `pendingQuestions`, the questions T3 still lists for its thread, and says they need an answer with `work_respond`: interrupting a turn that waited on a question may leave the question pending and the job `needs_input`. Its description also says the interrupted turn may be one the operator started in T3.
- Coordinators that delegate: every job view has `waitingOnDelegatedWork` and `delegatedTasks`, from the thread's `subagent` items that T3 shows as still running (followed by item id until they finish). A turn that ends with delegated work running is reported with reason `waiting_on_delegated_work`, and a turn the job starts by itself (T3 resuming a coordinator when its child finishes, or a person typing in T3) with reason `turn_started` (or `turn_finished` when it began and ended between two checks). The idle state meaning, the attention reasons and the `work_continue`, `work_feed` and `work_status` descriptions now tell agents that a coordinator goes idle while its delegated work runs and resumes by itself: read its reply, and if it delegated or is waiting, wait for its next turn instead of sending instructions. Schema migration 3 adds `jobs.delegated_work`.
- Delegated work that ends without the coordinator resuming (a child that failed or was cancelled, and T3 started no new parent run): the watcher appends the new event `delegated_work_ended` (reason `no_turn_started`), and the job enters `work_feed`'s attention list with "Its delegated work has ended (finished, failed or cancelled) but it did not resume. Send work_continue asking it to check on that work." The idle state meaning, the attention reasons and the `work_continue`, `work_feed` and `work_status` descriptions now say that `waitingOnDelegatedWork` wins over the reply text when they disagree (live, T3 shows a running child's `subagent` item as `running`, then `completed`).
- Delegated tasks followed per job raised from 20 to 200. Running tasks beyond those are counted in the new job view field `delegatedTasksUntracked` instead of being dropped; while it is above 0, `waitingOnDelegatedWork` stays true until the coordinator has run a new turn, and the attention reason says `following 200 of N delegated tasks; ask the coordinator for status before sending more work`. A job that finishes (`cancelled`, `failed`, `released`) no longer keeps its delegated work. Schema migration 5 adds `jobs.delegated_untracked`, `jobs.delegated_untracked_run_id` and `jobs.delegated_ended_at`.
- The adoption scan for delegated work keeps at least 5 of its 20 reads for looking back from the thread's last message, so a coordinator with a long activity tail after it is still found waiting.
- docs/operations.md gives the deploy order: stop the service, back up `gateway.db` and `gateway.key`, run `doctor` from the new checkout (it applies migrations and prints failures), then `install.sh`.
- `t3-fleet-gateway jobs list [--all]`: open jobs (with `--all`, finished ones too) with project, state, standing flag, title and link.
- Schema migration 2: `jobs.standing` and the terminal job state `released`, for standing jobs. It rebuilds the `jobs` table to change its state constraint and keeps every row, event and request id. Migrations are append-only from here on. Back up the data directory before updating a deployed gateway (see docs/operations.md).
- `doctor`'s public URL check requires this gateway's own metadata (`resource_name` `t3-fleet-gateway`), so another server's metadata for the same resource fails it.
- `clients token --name <name> [--access operate|read] [--ttl <duration>|never]`: a bearer token for an agent that cannot sign in with OAuth (Notion's custom MCP connections offer only header authentication). Printed once and stored as a hash; Operate and one year by default; listed by `clients list` with its expiry and cut off by `clients revoke`. Durations accept `y` (365 days).
- `work_messages` (read scope): a job's worker messages in full, read live from T3, up to 50,000 characters each, with `textTruncated` and `length`. Without `before` or `after` it returns the latest (`limit`, default 1, at most 10); `earlier` and `later` page back and forward. `work_status` has `excerptTruncated` (schema migration 6), and its summary and the attention reasons point to `work_messages` when the excerpt is cut.

### Fixed

- `mine: true` in `work_feed` and `work_list` left out standing jobs, so an agent filtering with it never saw the coordinator it drives. It now includes every standing job.
- Delegated work (`waitingOnDelegatedWork`, `delegatedTasks`) was never detected against a real T3: the watcher looked for `subagent` items in thread reads that named no view, and T3's default `messages` view returns only user and assistant messages and plans. The watcher now reads T3's `activity` view for delegated work, with a read position of its own (schema migration 4 adds `jobs.activity_position`) and one character per item, while replies, the excerpt and the job's state still come from the messages view, so a coordinator's reasoning and tool activity never delays them. Adoption starts the activity position at the thread's current end and finds delegated work still running with a bounded scan back from the last message; a standing job adopted before this update is scanned the same way on its first check. Every job, launched ones too, is checked for delegated work. Every thread read now names its view, and the test fake models both views.
- A pending item in a thread's timeline (a command still running, or a coordinator's delegated work, which stays pending for as long as the child works) held the watcher's read position back and hid every later message from the excerpt. Only a worker message still being written holds the position now, and the excerpt is the newest settled worker message read.
- Migration 2 failed on a version 1 database created by an early build of migration 1 (no `state_changed_at` or `t3_thread_link`, or a text `read_position`). It now copies the columns the table actually has, fills `state_changed_at` from `updated_at`, leaves `t3_thread_link` empty and converts `read_position` to an integer (empty when it is not a number). A failed migration, including a database locked by another process (`SQLITE_BUSY`), is now reported as `database_error` naming the migration, instead of a raw SQLite error.
- Approving in Chrome could leave the operator on the approval page: the form answered with a redirect to the client's callback, and Chrome applies the page's `form-action` to every redirect after a submission, so a callback that redirected on to another origin (as Cursor's does for Grok Bot) was blocked silently. Pressing Approve again then failed with "approval code was not accepted". The form now answers with a small page that navigates to the callback (meta refresh, plus a Continue link), for approvals, denials and request errors alike; `form-action` is `'self'` only. Submitting an approved form again shows the same authorization response while its code is unused and unexpired (no new code, no approval code spent, no failed attempt counted), and afterwards says the request was already approved.
- The CLI crashed with an unhandled `EPIPE` when its reader closed early (`t3-fleet-gateway pair | head -1`). Output to a closed pipe is now dropped and the command finishes with its own exit code; other stdout and stderr errors still fail it.
- `deploy/launchd/install.sh` could leave the service unloaded when reinstalling: `launchctl bootout` returns before launchd has removed the agent, and the immediate `bootstrap` failed with `Bootstrap failed: 5: Input/output error`. The installer now waits (up to 10 seconds) until the agent is gone and retries the bootstrap once; `--uninstall` waits too.
- The CLI silently ignored `--title`, `--all` and `--ttl` on commands that do not take them; they are now usage errors (exit 2) outside `jobs adopt`, `jobs list` and `pair` respectively.
- `deploy/launchd/install.sh` took any `launchctl print` failure as "the agent is unloaded". Only exit 113 ("Could not find service") counts now; another failure is reported with its exit status (`--uninstall` stops and keeps the plist).
- OAuth client ids could start with `-`, which `clients revoke <id>` read as an unknown option (exit 2); new ids never do, and `clients revoke -- <id>` revokes an earlier one.

### Known limitations

- `allowWorkStart: false` refuses new `work_start` calls only; jobs already queued in the project still dispatch.
- Permission approvals cannot be answered through T3's MCP tools; jobs waiting on one show `needs_input` with `waitingForApproval`, and the operator approves in T3. Projects that should run unattended need `runtimeMode` `auto` or `full-access`.
- The state derivation and worker-message detection follow T3's published tool schemas. A live run confirmed finished turns, worker replies, follow-ups and interrupting a running job; questions, approvals and failed runs are not yet confirmed against a real T3.
- An `unknown` job whose marker lookups keep failing with T3 errors stays `unknown`, holding its slot, until a lookup succeeds: a failed lookup is not evidence that the launch did not happen. Its `lastError` shows the failure.
- Node 26.0's bundled undici can throw `setTypeOfService EINVAL` as an uncaught exception when a peer resets a connection just as it opens (on macOS, for example when T3 restarts). `serve` logs it as `process.transient_socket_error` and keeps running, and the T3 client treats it as not delivered if it ever surfaces as a request failure; any other uncaught error stops `serve` gracefully with exit code 1 so its supervisor restarts it. The latest Node 24 or 26 release is recommended.
- A superseded sibling token pair's access token stays valid until it expires (see docs/security.md, "A refresh token is stolen").
