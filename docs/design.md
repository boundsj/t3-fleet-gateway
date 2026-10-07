# t3-fleet-gateway design

Status: accepted for v0.1. This document is the build specification and stays as the architecture reference. Update it when behavior changes.

## Outcome

Long-running AI agents hosted in the cloud, starting with Grok Bot, can hand coding work to the T3 Code servers on your own machines and follow it to completion. The agent says *what* to do in *which project*. The gateway decides *where* and *how*: which machine, which T3 project, a fresh git worktree per job, the T3 thread, and watching it. The person supervising never has to pick worktrees or threads, or keep checking threads by hand.

T3 Code stays the execution surface. Every job is an ordinary T3 thread the person can open, read, and interrupt.

### In scope for v0.1

- One gateway process on an always-on machine, reachable over public HTTPS through a tunnel the operator provides.
- Agent-facing MCP server (Streamable HTTP) with the gateway's own OAuth 2.1 authorization server, including refresh tokens, so agents stay signed in.
- Downstream MCP client to one or more T3 Code servers, with credentials the gateway obtains and renews itself through T3's pairing-code approval.
- A durable job ledger in SQLite, the eight tools below, a background watcher, and an operator CLI.
- Multi-host configuration and routing by project. The first deployment enrolls one host; adding a second host is configuration plus enrollment, not new code.

### Out of scope for v0.1

- Patching T3 Code. Gaps are worked around in the gateway.
- Waking idle agents. Agents poll the feed on their own schedules (Grok Bot routines do this).
- Multi-user tenancy. One operator; agents are that operator's clients.
- Queues across hosts, automatic host failover, attachments, PR management, model selection heuristics.
- A web UI beyond the OAuth approval page.

## Architecture

```
Agent (Grok Bot, any MCP client)
   │  HTTPS, OAuth 2.1 (gateway-issued tokens; audience = this gateway)
   ▼
t3-fleet-gateway  ── SQLite (clients, tokens, hosts, jobs, events)
   │  MCP client per host, bearer token issued by that host's T3 (audience = that T3)
   ▼
T3 Code server(s)  ──► T3 threads in per-job git worktrees
```

Two credential audiences never mix. Agent tokens are only valid at the gateway. T3 tokens never leave the gateway.

### Runtime

- Node.js ≥ 24 running TypeScript directly (type stripping, no build step). ES modules, `.ts` import specifiers, erasable syntax only.
- SQLite through `node:sqlite`, WAL mode, `busy_timeout` set, migrations versioned in code.
- The official MCP TypeScript SDK for both the server and the client: the v2 split packages `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (2.3.x). v2 is the SDK's stable, documented line (the v1 `@modelcontextprotocol/sdk` package is the previous generation, and its docs point new work at v2). The split packages are also far lighter: the server needs only `zod` and the shared core, while 1.x pulls in Express, Hono, CORS and rate-limit middleware we would not use. v2 serves 2025-era clients (Grok Bot today) and 2026-07-28 clients from one endpoint. v2 no longer ships authorization-server helpers (they are frozen in a legacy package), so the gateway implements its small OAuth server directly on `node:http`.
- Runtime dependencies: the two SDK packages and `zod` (the SDK's schema library, also used for config and tool input validation). Nothing else.
- Tests with `node:test`. Typecheck with `tsc --noEmit`.

### Process layout

One process, `t3-fleet-gateway serve`, runs the HTTP server, the watcher loop, the dispatcher, and credential renewal. A CLI with the same entrypoint manages it. The CLI and the server share the SQLite database, so CLI actions (minting an approval code, revoking a client) take effect without a restart.

## Configuration and data

Nothing machine-specific lives in the repository.

- Config file, JSON: `$T3FG_CONFIG` or `~/.config/t3-fleet-gateway/config.json`.
- Data directory: `$T3FG_DATA_DIR` or `~/.local/share/t3-fleet-gateway/`. Created with mode `0700`; the database and key files with `0600`. Startup refuses to run if they are group- or world-readable.
- A committed `config.example.json` uses only placeholder values (`example.ts.net`, `/path/to/repo`).

Config fields (validate on load with clear errors):

```jsonc
{
  "publicUrl": "https://gateway.example.ts.net:8443",   // origin agents use; OAuth metadata derives from it
  "listen": { "host": "127.0.0.1", "port": 3790 },
  "hosts": [
    {
      "id": "mini",                                      // stable short id used in project config and output
      "label": "Always-on Mac",
      "t3Url": "http://127.0.0.1:3773",                  // loopback http, or https for a remote host
      "mintPairingCode": ["t3", "auth", "pairing", "create", "--ttl", "5m", "--json"],
      "access": "auto",                                  // T3 approval level the gateway requests
      "maxConcurrentJobs": 2
    }
  ],
  "projects": [
    {
      "alias": "pilot",                                  // what agents use
      "description": "Scratch repo for gateway tests",   // shown to agents
      "host": "mini",
      "t3ProjectId": "…",                                // or "t3ProjectTitle" resolved at startup
      "baseRef": "main",
      "branchPrefix": "fleet/",
      "runtimeMode": "approval-required",                // T3 runtime mode for job threads
      "modelSelection": null                             // optional T3 modelSelection object
    }
  ],
  "tokens": { "accessTtlSeconds": 43200, "refreshIdleTtlDays": 90 },
  "renewal": { "renewWhenDaysLeft": 5, "checkEveryMinutes": 60 },
  "watcher": { "pollSeconds": 10 }
}
```

`runtimeMode` defaults to `approval-required` when omitted. Operators choose looser modes per project deliberately.

## Agent-facing authorization (gateway as OAuth server)

Follow the MCP authorization spec (2025-06-18) and OAuth 2.1:

- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`: resource = `${publicUrl}/mcp`, authorization server = `publicUrl`.
- `GET /.well-known/oauth-authorization-server`: issuer, endpoints, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `token_endpoint_auth_methods_supported: ["none"]`, scopes.
- `POST /oauth/register`: dynamic client registration (RFC 7591), public clients only. Accept loopback `http` and any `https` redirect URIs (hosted agents such as Grok Bot use `https://www.cursor.com/agents/mcp/oauth/callback`). Reject fragments, credentials in URLs, non-http(s) schemes. Store the client; cap name and redirect counts and lengths.
- `GET /oauth/authorize`: validate client, redirect URI exact match, PKCE S256, `resource` (if present) equals ours, scopes. Render the approval page. Never redirect for an invalid client or redirect URI.
- Approval page: server-rendered HTML, no external assets, strict CSP, `X-Frame-Options: DENY`. Shows the client name, the redirect origin in full, and requested access. The operator enters a one-time approval code and chooses **Read** (`fleet:read`) or **Operate** (`fleet:read fleet:operate`). The form carries an HMAC of the authorization request to prevent tampering.
- Approval codes: minted by the CLI (`t3-fleet-gateway pair --ttl 15m`), stored hashed, single use, expire. Throttle failures: per authorization request and globally (for example 5 per request, 20 per hour), then refuse new attempts for a cool-down and log it.
- `POST /oauth/token`:
  - `authorization_code`: single-use codes (60 s), PKCE verification, redirect URI and client match, `resource` match. Issue an access token and a refresh token.
  - `refresh_token`: rotation. The new pair replaces the old. Reuse of a rotated refresh token after a short grace window (about 2 minutes, to absorb client retries) revokes the whole token family. Refresh tokens expire after `refreshIdleTtlDays` without use.
- Tokens are random 256-bit values, stored only as SHA-256 hashes. Access tokens are bound to the resource and scopes.
- `/mcp` requires `Authorization: Bearer`; failures return 401 with `WWW-Authenticate: Bearer resource_metadata="…"`. Insufficient scope returns a clear tool error naming the missing scope.
- CLI: `clients list`, `clients revoke <id>` (revokes all tokens for the client).

## Agent-facing MCP server

- Streamable HTTP on `POST /mcp`. Stateless mode with JSON responses (survives restarts, no session affinity). 2026-07-28 requests go to the SDK's `createMcpHandler`; 2025-era requests (classified with the SDK's `isLegacyRequest`) are served by a fresh stateless `WebStandardStreamableHTTPServerTransport` per request with `enableJsonResponse`, because the handler's built-in legacy fallback always answers with an SSE stream. `GET` and `DELETE` on `/mcp` answer `405`: there are no sessions to stream or end.
- Must accept in-session requests that omit `MCP-Protocol-Version` (observed from Grok Bot's client). Add a regression test.
- Origin header validation per the spec's DNS-rebinding guidance, without breaking server-to-server clients that send no Origin.
- Tool results: `structuredContent` plus a short human-readable `text` summary. Errors as tool errors (`isError: true`) with a stable `code` and actionable message.

### Tools

Scopes: **read** = `fleet:read`, **operate** = `fleet:operate`.

| Tool | Scope | Purpose |
| --- | --- | --- |
| `fleet_status` | read | Hosts (reachable, T3 version, credential expiry, running and queued job counts), configured projects (alias, description, host), gateway version. |
| `work_list` | read | Jobs filtered by project and state, newest first, bounded. |
| `work_status` | read | One job: state, project, host, T3 thread id and title, branch, timestamps, pending requests, latest worker message excerpt (bounded), last error. |
| `work_feed` | read | Events since a cursor (state changes, needs input, finished turns, failures) plus the list of jobs currently needing attention. Returns the next cursor. Designed for an agent's scheduled routine. |
| `work_start` | operate | Start a job in a project from a task description. Idempotent on `requestId`. |
| `work_continue` | operate | Send a follow-up instruction to a job's thread. Idempotent on `requestId`. |
| `work_respond` | operate | Answer a pending T3 request on a job (approval decision or question answer). |
| `work_cancel` | operate | Interrupt a job's thread. Reports requested versus confirmed. |

Tool descriptions are written for an LLM: what the tool does, when to use it, idempotency rules, and the state meanings.

## Jobs

### States

`queued → dispatching → running ⇄ needs_input → idle`, plus `cancel_requested → cancelled`, `failed`, and `unknown`.

- `idle`: the worker finished its turn and is waiting. This is "ready for review or next instruction", not proof the task met its goal. `work_continue` moves it back to `running`.
- `needs_input`: T3 reports pending approvals or questions for the thread.
- `unknown`: the gateway cannot tell whether a launch happened (for example the response was lost). Never auto-retried. Reconciliation resolves it.
- Terminal: `cancelled`, `failed`. Host unreachability is an observation recorded on the job, not a failure.

Every transition appends to `job_events` (append-only) with a monotonically increasing id that serves as the feed cursor.

### Starting a job

1. Validate scope, project alias, task size. Look up `(clientId, requestId)`: same request and same input hash returns the existing job; same request with different input is rejected.
2. Insert the job as `queued` with a short job id and a branch name `${branchPrefix}${jobId}`, in one transaction with its first event.
3. The dispatcher takes queued jobs while the host is below `maxConcurrentJobs`, marks `dispatching`, then calls `t3_thread_launch` with `projectId`, `title` containing the marker `[job:<jobId>]`, `workspaceStrategy: { type: "worktree", baseRef, branch, startFromOrigin: false }`, `runtimeMode`, optional `modelSelection`, and `message` = task plus a short footer naming the job id.
4. Success records the thread id and moves to `running`. A definite rejection (validation error) moves to `failed` with the reason. Anything ambiguous (timeout, connection reset after sending) moves to `unknown`.

### Reconciliation

- `unknown` and stale `dispatching` jobs (including after a restart) are reconciled by searching the project's threads for the marker (`t3_thread_search` or `t3_thread_list` with `projectId`). Found: attach the thread and continue. Not found for a configured window with the host reachable: `failed` with reason `launch_not_confirmed`. Never relaunch automatically; the agent may start a new request.

### Watching

- The watcher polls active jobs every `pollSeconds` with `t3_thread_read` (incremental where supported) and `t3_pending_request_list`. It derives the state, records the latest assistant message excerpt and activity time, and emits events on change.
- On startup, the watcher resumes every non-terminal job.
- Unreachable hosts: back off, record `hostUnreachableSince`, keep the job's state.

### Follow-ups, responses, cancel

- `work_continue`: `t3_thread_send` to the job thread; idempotent on `requestId` (stored).
- `work_respond`: `t3_pending_request_respond` for a pending request id belonging to the job's thread only.
- `work_cancel`: `t3_thread_interrupt`; `cancel_requested` until the watcher sees the thread stop, then `cancelled`. A queued job cancels immediately without contacting T3.

## Downstream T3 credentials

Per host, the gateway obtains a T3 MCP credential with T3's documented pairing-code approval, with no browser:

1. `POST {t3Url}/oauth/mcp/register` with a loopback redirect URI (`http://127.0.0.1:<unused-port>/callback`); the redirect is never followed.
2. Run the host's `mintPairingCode` command (local `t3` CLI, or for a remote host, an operator-provided command such as `ssh other-host t3 auth pairing create …`) and parse `credential` from its JSON.
3. `POST {t3Url}/oauth/mcp/decision` with `{ authorization: {response_type, client_id, redirect_uri, code_challenge, code_challenge_method: "S256", state, resource}, decision: { _tag: "pairing-code", access, code } }`, read `redirectTo`, extract `code`.
4. `POST {t3Url}/oauth/mcp/token` (form-encoded, PKCE verifier, `resource = {t3Url}/mcp`). Store the access token and its expiry.
5. Verify with `t3_environment_read`, then switch over.

T3 issues no refresh tokens; credentials last 30 days. The renewal job re-enrolls when fewer than `renewWhenDaysLeft` days remain, keeps the old credential until the new one is verified, and alerts in logs and `fleet_status` if renewal fails. Old T3 sessions expire on their own; the operator can revoke them in T3's Settings → Connections.

CLI: `hosts enroll <id>`, `hosts status`.

This automates T3's consent step using the operator's own machine access (the same access needed to run `t3 auth pairing create`). Document this clearly.

## Security and privacy

- No secrets in the repository, examples, tests, or logs. Tests use generated values.
- Logs are JSON lines with ids, states, tool names, durations, and opaque client ids. Never tokens, approval or pairing codes, authorization headers, task text, or worker message content.
- Task text and message excerpts live only in the local database.
- Listen on loopback; expose through the operator's tunnel.
- Bound request body sizes and string lengths; validate all tool inputs with schemas.
- The approval page is the only HTML; it is self-contained.
- `SECURITY.md` explains how to report vulnerabilities and the threat model.

## Operations

- `deploy/launchd/` template and installer for macOS (KeepAlive); a `systemd` user unit example for Linux.
- `t3-fleet-gateway doctor`: config validity, file permissions, database health, each host's reachability and credential expiry, public URL metadata.
- Graceful shutdown: stop accepting, finish in-flight requests, persist watcher state.

## Testing

- Unit: config validation, OAuth flows (registration rules, PKCE, code reuse, refresh rotation, reuse detection and grace window, expiry, revocation, throttling), job state machine, idempotency, reconciliation decisions.
- Integration: the gateway against a fake T3 MCP server built with the SDK that implements the T3 tools the gateway uses and supports failure injection (lost launch response, timeouts, pending requests, unreachable host). Includes restart recovery: stop the gateway mid-job, start it again, the same job continues.
- Agent path: an SDK client that performs registration, approval with a minted code, token exchange, refresh, and tool calls, including a request without `MCP-Protocol-Version`.
- Live end-to-end against a real T3 server: a script outside the automated suite, run against a scratch project.

## Decisions log

- Gateway terminates MCP itself instead of proxying T3's MCP: agents get a small job-level contract, and client quirks are absorbed by our server.
- Downstream access level defaults to T3 "auto" (Full access) because the gateway enforces its own scopes and per-project runtime modes.
- Polling instead of webhooks: T3 has no completion webhooks; the gateway is always on.
