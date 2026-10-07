# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## Unreleased (0.1.0)

### Added

- Agent-facing MCP server on `/mcp` (Streamable HTTP, stateless, JSON responses) that serves both 2025-era and 2026-07-28 clients and accepts requests without `MCP-Protocol-Version`.
- OAuth 2.1 authorization server: metadata, dynamic registration for public clients, an approval page gated by one-time codes minted with `pair` (Read or Operate), PKCE S256, rotating refresh tokens with replay detection and a retry grace window, idle expiry, and per-client revocation.
- Downstream T3 Code client per host, with enrollment through T3's pairing-code approval, verified credential storage, and automatic renewal before the 30-day expiry.
- `fleet_status` tool.
- CLI: `serve`, `pair`, `clients list|revoke`, `hosts enroll|status`, `doctor`.
- SQLite storage with versioned migrations, including the tables for the job layer.
- launchd installer and systemd user unit.
- Job layer: `work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list` and `work_feed`. Jobs run as T3 threads titled `[job:<id>]` in fresh worktrees on `<branchPrefix><id>`, with a durable ledger and append-only event feed, request-id idempotency, a per-host FIFO dispatcher that respects `maxConcurrentJobs`, a watcher that derives `running`, `needs_input`, `idle` and `failed` from T3 thread reads, host backoff that never changes job state (a slow launch makes only that job `unknown`; a T3 error about one job is recorded on that job and never stalls the others), reconciliation of launches whose outcome was lost or that T3 answered with an error that may leave a thread (by the title marker at the end of the title, in unsettled and settled threads, never relaunched; `launch_not_confirmed` after `watcher.reconcileWindowMinutes`), and cancels that keep interrupting each run that starts on the thread until it stops (one T3 `clientRequestId` per run). A found thread on which no run ever started fails the job with `launch_not_started` (keeping the thread's id and link) instead of reporting a finished turn; any failed lookup after a launch error leaves the job `unknown`; a search match T3 refuses to read is skipped.
- T3 client wrappers for the thread and pending-request tools, and transport errors that say whether T3 may have received the call (`T3TransportError.delivery`; new error code `t3_response_lost`).
- Every job view carries `stateChangedAt` (when the job entered its current state; the feed's attention window and order use it) and `updatedAt` (the last real change, including the host-unreachable mark, not the last poll).
- Every job view carries `link`, which opens the job's thread in the T3 app, from the launch result on.
- Error codes `job_state_conflict` and `request_id_conflict`.
- Config: `watcher.reconcileWindowMinutes`; `hosts[].defaultModelSelection`, the model for projects on that host that set no `modelSelection` (T3 refuses launches without a model when the T3 project has no default). `doctor` fails a project that would have no model, `serve` logs `project.model_missing` at startup (in the background: shutdown does not wait for it, and a host that fails is not asked again for its other projects), and `fleet_status` shows each project's `runtimeMode` and `modelConfigured`.
- `config.example.json` enrolls its host with `access: "full-access"`: the host's access is only a ceiling, and each project's `runtimeMode` (default `approval-required`) is what limits a job.
- `scripts/e2e-live.ts`: a live end-to-end check against a running gateway and a real T3 host (`npm run e2e:live`), outside the test suite.
- `doctor`'s public URL check requires this gateway's own metadata (`resource_name` `t3-fleet-gateway`), so another server's metadata for the same resource fails it.

### Known limitations

- Permission approvals cannot be answered through T3's MCP tools; jobs waiting on one show `needs_input` with `waitingForApproval`, and the operator approves in T3. Projects that should run unattended need `runtimeMode` `auto` or `full-access`.
- The state derivation and worker-message detection follow T3's published tool schemas. A live run confirmed finished turns, worker replies and follow-ups; questions, approvals, failed runs and interrupting a running job are not yet confirmed against a real T3.
- An `unknown` job whose marker lookups keep failing with T3 errors stays `unknown`, holding its slot, until a lookup succeeds: a failed lookup is not evidence that the launch did not happen. Its `lastError` shows the failure.
- A superseded sibling token pair's access token stays valid until it expires (see docs/security.md, "A refresh token is stolen").
