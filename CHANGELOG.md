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
- Job layer: `work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list` and `work_feed`. Jobs run as T3 threads titled `[job:<id>]` in fresh worktrees on `<branchPrefix><id>`, with a durable ledger and append-only event feed, request-id idempotency, a per-host FIFO dispatcher that respects `maxConcurrentJobs`, a watcher that derives `running`, `needs_input`, `idle` and `failed` from T3 thread reads, host backoff that never changes job state (a slow launch makes only that job `unknown`; a T3 error about one job is recorded on that job and never stalls the others), reconciliation of launches whose outcome was lost (by title marker, never relaunched; `launch_not_confirmed` after `watcher.reconcileWindowMinutes`), and cancels that keep interrupting each run that starts on the thread until it stops (one T3 `clientRequestId` per run).
- T3 client wrappers for the thread and pending-request tools, and transport errors that say whether T3 may have received the call (`T3TransportError.delivery`; new error code `t3_response_lost`).
- Error codes `job_state_conflict` and `request_id_conflict`.
- Config: `watcher.reconcileWindowMinutes`.
- `scripts/e2e-live.ts`: a live end-to-end check against a running gateway and a real T3 host (`npm run e2e:live`), outside the test suite.

### Known limitations

- Permission approvals cannot be answered through T3's MCP tools; jobs waiting on one show `needs_input` with `waitingForApproval`, and the operator approves in T3.
- The state derivation and worker-message detection follow T3's published tool schemas and have not yet been confirmed against a live T3 server.
