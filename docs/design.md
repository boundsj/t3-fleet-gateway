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
  "watcher": { "pollSeconds": 10, "reconcileWindowMinutes": 10 }
}
```

`runtimeMode` defaults to `approval-required` when omitted. Operators choose looser modes per project deliberately.

Validation rules beyond types (see `docs/configuration.md` for every field):

- `publicUrl`, `t3Url` and `allowedOrigins` entries are origins only; `http` is accepted only for loopback hosts.
- `listen.host` must be a loopback address.
- T3 `access` is one of `read-only`, `approval-required`, `auto-accept-edits`, `auto`, `full-access`. T3 treats it as the ceiling for thread runtime modes, so a project's `runtimeMode` may not exceed its host's `access`, and a `read-only` host carries no projects.
- Optional `allowedOrigins` (default empty) lists extra `Origin` values `/mcp` accepts besides `publicUrl`.

## Agent-facing authorization (gateway as OAuth server)

Follow the MCP authorization spec (2025-06-18) and OAuth 2.1:

- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`: resource = `${publicUrl}/mcp`, authorization server = `publicUrl`.
- `GET /.well-known/oauth-authorization-server`: issuer, endpoints, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `token_endpoint_auth_methods_supported: ["none"]`, scopes.
- `POST /oauth/register`: dynamic client registration (RFC 7591), public clients only. Accept loopback `http` and any `https` redirect URIs (hosted agents such as Grok Bot use `https://www.cursor.com/agents/mcp/oauth/callback`). Reject fragments, credentials in URLs, non-http(s) schemes. Store the client; cap name and redirect counts and lengths.
- `GET /oauth/authorize`: validate client, redirect URI exact match (as built: `http` loopback URIs match with any port, per RFC 8252 section 7.3), PKCE S256, `resource` (if present) equals ours, scopes. Render the approval page. Never redirect for an invalid client or redirect URI.
- Approval page: server-rendered HTML, no external assets, strict CSP, `X-Frame-Options: DENY`. Shows the client name, the redirect origin in full, and requested access. The operator enters a one-time approval code and chooses **Read** (`fleet:read`) or **Operate** (`fleet:read fleet:operate`). The form carries an HMAC of the authorization request to prevent tampering.
- Approval codes: minted by the CLI (`t3-fleet-gateway pair --ttl 15m`), stored hashed, single use, expire. Throttle failures: per authorization request and globally (for example 5 per request, 20 per hour), then refuse new attempts for a cool-down and log it.
  - As built: codes are 10 Crockford base32 characters (50 bits), shown as `XXXXX-XXXXX`, accepted in any case and spacing, stored as HMAC-SHA256 under the server key, TTL 15 minutes by default (1 minute to 24 hours). After 5 failures an authorization request is locked; after 20 failures in a rolling hour all approvals are refused until the hour clears (that window is the cool-down) or the operator mints a new code: minting marks earlier failures as no longer counting globally (`approval_failures.counts_globally`), since anyone who can reach the page could otherwise keep the operator locked out. Per-request locks stay. The approval form expires 10 minutes after it is rendered.
  - Registration is limited to 30 new clients per hour. A client without a completed authorization stops counting after 10 minutes, and clients that never complete an approval are deleted after a day.
  - `t3-fleet-gateway throttle status` shows both global limits; `throttle reset` deletes recorded approval failures (lifting per-request locks too) and stops existing registrations from counting (`oauth_clients.counts_toward_limit`).
- `POST /oauth/token`:
  - `authorization_code`: single-use codes (60 s), PKCE verification, redirect URI and client match, `resource` match. Issue an access token and a refresh token.
  - `refresh_token`: rotation. The new pair replaces the old. Reuse of a rotated refresh token after a short grace window (about 2 minutes, to absorb client retries) revokes the whole token family. Refresh tokens expire after `refreshIdleTtlDays` without use.
    - As built: a rotated token presented again within 2 minutes (a lost response, or concurrent requests refreshing with the same token) gets another pair, a sibling of the first; siblings coexist, so whichever pair the client saved works. When any sibling is first rotated, the other siblings are superseded and the parent can no longer be retried. Presenting a superseded token, or a rotated one after the grace window or after one of its children was rotated, revokes the family. Each refresh token records the token it was issued from (`refresh_tokens.parent_hash`).
- Tokens are random 256-bit values, stored only as SHA-256 hashes. Access tokens are bound to the resource and scopes.
- `/mcp` requires `Authorization: Bearer`; failures return 401 with `WWW-Authenticate: Bearer resource_metadata="…"`. Insufficient scope returns a clear tool error naming the missing scope.
- CLI: `clients list`, `clients revoke <id>` (revokes all tokens for the client).

## Agent-facing MCP server

- Streamable HTTP on `POST /mcp`. Stateless mode with JSON responses (survives restarts, no session affinity). 2026-07-28 requests go to the SDK's `createMcpHandler`; 2025-era requests (classified with the SDK's `isLegacyRequest`) are served by a fresh stateless `WebStandardStreamableHTTPServerTransport` per request with `enableJsonResponse`, because the handler's built-in legacy fallback always answers with an SSE stream. `GET` and `DELETE` on `/mcp` answer `405`: there are no sessions to stream or end.
- Must accept in-session requests that omit `MCP-Protocol-Version` (observed from Grok Bot's client). Add a regression test.
- Origin header validation per the spec's DNS-rebinding guidance, without breaking server-to-server clients that send no Origin. As built: a request with an `Origin` other than `publicUrl` or an `allowedOrigins` entry gets `403`; no `Origin` is accepted. The `Host` header is not validated, because tunnels differ in what they forward and every `/mcp` request needs a bearer token anyway.
- Tool results: `structuredContent` plus a short human-readable `text` summary. Errors as tool errors (`isError: true`) with a stable `code` and actionable message.

### Tools

Scopes: **read** = `fleet:read`, **operate** = `fleet:operate`.

| Tool | Scope | Purpose |
| --- | --- | --- |
| `fleet_status` | read | Hosts (reachable, T3 version, credential expiry or `rejected` when T3 answers 401/403, running and queued job counts), configured projects (alias, description, host), gateway version. "Running" counts the states that hold a concurrency slot: `dispatching`, `running`, `needs_input`, `cancel_requested` and `unknown`. |
| `work_list` | read | Jobs filtered by project and state, newest first, bounded. |
| `work_status` | read | One job: state, project, host, T3 thread id, title and app link, branch, timestamps, pending requests, latest worker message excerpt (bounded), last error. |
| `work_feed` | read | Events since a cursor (state changes, needs input, finished turns, failures) plus the list of jobs currently needing attention. Returns the next cursor. Designed for an agent's scheduled routine. |
| `work_start` | operate | Start a job in a project from a task description. Idempotent on `requestId`. |
| `work_continue` | operate | Send a follow-up instruction to a job's thread. Idempotent on `requestId`. |
| `work_respond` | operate | Answer a pending T3 question on a job. (Permission approvals cannot be answered through T3's tools; see "As built" under Jobs.) |
| `work_cancel` | operate | Interrupt a job's thread. Reports requested versus confirmed. |

Tool descriptions are written for an LLM: what the tool does, when to use it, idempotency rules, and the state meanings.

As built, tools are registered in this order: `fleet_status`, `work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list`, `work_feed` (`src/mcp/workTools.ts`). Job errors use these stable codes besides the shared ones: `not_found` (job, project or pending request), `job_state_conflict` (the job's state does not allow the operation), `request_id_conflict` (a requestId reused with different input for the same tool), and T3 transport codes `host_unreachable`, `t3_timeout`, `t3_response_lost`.

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

### As built

This section records how the job layer behaves in detail, including where it differs from or refines the plan above. Code: `src/jobs/` (store, service, engine, derive, interrupt) and `src/mcp/workTools.ts`.

**Engine.** One loop (`JobEngine`) ticks every `watcher.pollSeconds`, and at once after `work_start`, `work_continue`, `work_respond` and `work_cancel`. Ticks never overlap. Per host with open jobs, a tick runs, in order: reconciliation, watching, dispatch. Hosts are processed in parallel.

**Events.** Every state change appends a `state_changed` event (`fromState`, `toState`, and a `reason` such as `launched`, `reconciled`, `completed`, `question`, `approval`, `followup`, `input_answered`, `interrupted`, `launch_rejected`, `launch_not_confirmed`, `run_failed`). The first event of a job is `created`. Events that are not state changes: `followup_sent` (a follow-up steered into or queued behind an active turn), `input_answered` (with the T3 request id), `turn_finished` (an idle job finished another turn started from T3 itself). Event details hold gateway-generated reasons and codes only, never content.

**Starting.** Job ids are 10 lowercase Crockford base32 characters (safe in branch names, titles and search). The thread title is the agent's `title` (optional, at most 80 characters) or the task's first non-empty line, cut to 60 characters, followed by ` [job:<id>]`. The task (at most 20,000 characters) is sent with the footer `Started through t3-fleet-gateway as job <id>, in a fresh worktree on branch <branch>.` Request ids are scoped to the calling agent and the tool (`idempotency_keys` is keyed by client, tool and request id), so an id used with `work_start` and again with `work_continue` names two separate requests. The input hash covers the project, task and title.

**Dispatch.** Slots: `dispatching`, `running`, `needs_input`, `cancel_requested` and `unknown` hold one; `idle` does not, so a host may start its next queued job while an idle job waits for review, and `work_continue` on an idle job does not wait for a slot. Queued jobs dispatch oldest first. Before launching, the engine makes one read-only call (`t3_environment_read`): after T3 restarts, the first write on a dead keep-alive connection fails with a reset that is indistinguishable from a lost response, and a read can safely absorb it. Project titles are resolved to ids with `t3_project_list` once per process. Launch outcomes:

| T3 client outcome | Job |
| --- | --- |
| Result | `running`, with the thread id and run id |
| Tool error (`isError`, T3 answered and refused) | `failed`, `lastError.code` = T3's code (for example `target_required`) |
| Transport failure, `delivery: not_delivered` | back to `queued`; the host is backed off |
| Transport failure, `delivery: unknown`, or an unexpected result shape | `unknown`; the host is backed off if it was a transport failure |

**T3 delivery classification** (`T3TransportError.delivery`, `src/t3/client.ts`). `not_delivered`: any failure while connecting or initializing the MCP session, a refused or unresolvable connection (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EADDRNOTAVAIL`, `UND_ERR_CONNECT_TIMEOUT`), `401`/`403` (`t3_unauthorized`), and other `4xx` answers (`host_unreachable`). `unknown`: a timeout after the request was sent (`t3_timeout`), a reset or closed socket, or a `5xx` answer (`t3_response_lost`). A `404` (T3 forgot the session) is retried once on a new session; read-only calls are also retried once after `host_unreachable` or `t3_response_lost`. The gateway treats every T3 `isError` result on a launch as a definite rejection: T3's tool reports a failure only when it did not create the thread. That is an assumption about T3, recorded here; the live end-to-end check is where it would show.

**Reconciliation.** A `dispatching` job that this process is not launching (after a crash or restart) becomes `unknown` (reason `dispatch_interrupted`). For each `unknown` job, and each `cancel_requested` job without a thread, the engine looks for the marker with `t3_thread_list { projectId, titleContains: "[job:<id>]" }`, then with `t3_thread_search { projectId, query: <id> }` confirmed by reading each match's title. Found: the thread is attached (`running`, or interrupted if the job was cancelled meanwhile). Not found: the window starts at the first miss and counts only while the host answers; when the host becomes unreachable the window restarts. After `reconcileWindowMinutes` the job fails with `launch_not_confirmed` (a cancelled one becomes `cancelled`). The window start is kept in memory, so a restart restarts it: conservative, never sooner. Nothing is relaunched.

**Watching and state derivation** (`src/jobs/derive.ts`). For each job with a thread in `running`, `needs_input` or `cancel_requested` (every tick) or `idle` (at most once a minute), the engine calls `t3_thread_read { threadId, afterPosition, limit: 100, runLimit: 5, maxCharsPerItem: 2000 }`, following `nextPosition` for up to 5 pages, then `t3_pending_request_list { threadId }`. It relies on these output fields: `thread.status`, `thread.activeRunId`, `thread.latestRunId`, `thread.pendingRequestCount`, `thread.updatedAt`, `recentRuns[].runId` and `.status`, `items[].position`, `.type`, `.createdBy`, `.creationSource`, `.status`, `.text`, `.updatedAt`, `nextPosition` and `hasMore`. The job keeps `lastRunId`: the run returned by `t3_thread_launch` or `t3_thread_send`, and the thread's `latestRunId` once a turn is over. Rules, first match wins:

1. A `cancel_requested` job becomes `cancelled` when nothing is active (rule 3 does not hold); otherwise the interrupt is re-sent (same `clientRequestId`, which T3 deduplicates).
2. `needs_input` when `t3_pending_request_list` returns ids, `thread.status` is `waiting`, the followed run is `waiting`, or a run is active and `pendingRequestCount` > 0. With no listed question ids, it is a permission approval (`waitingForApproval` in `work_status`, reason `approval`).
3. `running` when `thread.activeRunId` is set, `thread.status` is `preparing`, `queued`, `starting`, `running` or `waiting`, or the followed run (`lastRunId` in `recentRuns`) has one of those statuses. A status this build does not know counts as active.
4. `failed` (`lastError.code` `t3_run_failed`) when the latest run's status, or the thread's, is `failed`.
5. Otherwise `idle`: the turn is over (`completed`, `interrupted`, `cancelled`, `rolled_back`, or `idle`). A turn stopped from T3 by a person is therefore `idle`, not `cancelled`: the thread can take the next instruction.

The excerpt is the newest worker message among the items read, cut to 2,000 characters. A worker message is an item not created by a user, whose `type` does not mention `user`, and whose `type` mentions `assistant` or `plan`, or mentions `message` with `creationSource` `provider`. Messages the gateway or a person sent are excluded (T3 records the launch prompt and follow-ups as `user_message` items created by `agent` through `mcp`), and so is other activity such as `command_execution` or `checkpoint` items. A live read of a finished turn (thread `completed`, `activeRunId` null, latest run `completed`; items `user_message`, `command_execution`, `assistant_message`, `checkpoint`) is a test case in `test/jobs-derive.test.ts`. The read position is T3's `nextPosition` (`afterPosition` is exclusive), stored as an integer (`jobs.read_position INTEGER`); it never moves past an item whose status is `pending`, `running` or `waiting`, so a message still being streamed is read again once settled. T3 output statuses are parsed as strings so a new T3 status does not break watching. A T3 tool error naming a missing thread (`*not_found*`) fails the job (`thread_missing`), or cancels it if a cancel was requested; other tool errors are recorded on the job and retried next tick. An observation is written only if the job is still in the state it was read in, so an agent action that lands while T3 is being read (a follow-up, an answer, a cancel) is never overwritten by stale data.

**Hosts.** A transport failure on a host aborts that host's tick, marks it unreachable (`hostUnreachableSince` on all its open jobs, `jobs.host_unreachable` logged once) and backs it off: `pollSeconds` doubling per failure, at most 5 minutes. The next attempt starts with `t3_environment_read`; success clears the mark. Job states never change because a host is unreachable.

**Follow-ups.** `work_continue` accepts `idle`, `running` and `needs_input` jobs. It claims the request id before calling `t3_thread_send { threadId, message, mode: "auto", clientRequestId }`, where `clientRequestId` is derived from the job, the agent and its request id. A delivered request is answered from the stored result (`replayed: true`). A failure with `delivery: unknown` keeps the claim, and the agent is told to repeat the call with the same request id: the gateway sends again with the same `clientRequestId`, which T3 deduplicates. A tool error or `not_delivered` failure releases the claim. An idle job moves to `running`; otherwise a `followup_sent` event records the delivery (`steered` or `queued`).

**Responses.** `t3_pending_request_list` covers user questions only, and `t3_pending_request_respond` "cannot approve a permission request"; T3's MCP tools offer no way to answer approvals. `work_respond` therefore answers questions only: it lists the job thread's pending ids live and refuses any other id (so a request of another job's thread is refused), then passes `answers` through to T3 unchanged (an object, at most 16,000 characters of JSON). `work_status` reads each pending question (`t3_pending_request_read`, up to 5, 5-second timeout) so the agent sees the question text and options. Approvals are reported as `waitingForApproval`, and the operator gives them in T3. This is a deviation from the plan's "approval decision or question answer".

**Cancel.** `queued` → `cancelled` without T3. `cancelled` and `failed` are reported as they are. Otherwise the job becomes `cancel_requested` first (so the intent is durable), then `t3_thread_interrupt { threadId, clientRequestId: "t3fg-cancel-<id>" }` is called when the job has a thread: `interrupt_requested` keeps `cancel_requested` until rule 1 confirms; any other status (`no_active_run`, `completed`, `interrupted`, …) means nothing runs, so the job is `cancelled` at once (an idle job cancels this way). If T3 cannot be reached, the request stays and the watcher delivers it. A job cancelled while its launch is in flight or unconfirmed is interrupted as soon as its thread is known, and cancelled outright if the launch is rejected, never reached T3, or is not confirmed in the window. A T3 tool error on the interrupt is returned to the agent and the state is kept.

**Feed.** `work_feed` returns events with ids greater than the cursor (default 0), oldest first, `limit` default 50 and at most 200, plus `nextCursor` (the last returned id, or the given cursor) and `hasMore`. `attention` lists, newest change first and at most 50: `needs_input` and `unknown` jobs of any age, and `idle` and `failed` jobs changed within 24 hours. There is no acknowledgement state; an idle job leaves the list when it is continued, cancelled or 24 hours old. `mine: true` limits events and attention to jobs the calling agent started.

**Links.** T3 returns each thread's `link` as a markdown link, `[Title](t3-thread://v1/<environmentId>/<threadId>)`, which opens the thread in the T3 app. The first watcher read of a job's thread stores the target URL (`jobs.t3_thread_link`; only `t3-thread`, `https` and `http` URLs are kept), and every job view (`work_status`, `work_list` items, `work_feed` attention entries and the other tools' `job`) returns it as `link`, null until then, so an agent can hand the person a link to tap. It is never logged.

**Not stored in the database.** Backoff state, the reconciliation window start and idle poll times are in memory and restart conservatively.

## Downstream T3 credentials

Per host, the gateway obtains a T3 MCP credential with T3's documented pairing-code approval, with no browser:

1. `POST {t3Url}/oauth/mcp/register` with a loopback redirect URI (`http://127.0.0.1:<unused-port>/callback`); the redirect is never followed. The client is named `t3-fleet-gateway (<host id>)`, which is the label T3 shows for the resulting session.
2. Run the host's `mintPairingCode` command (local `t3` CLI, or for a remote host, an operator-provided command such as `ssh other-host t3 auth pairing create …`) and parse `credential` from its JSON.
3. `POST {t3Url}/oauth/mcp/decision` with `{ authorization: {response_type, client_id, redirect_uri, code_challenge, code_challenge_method: "S256", state, resource}, decision: { _tag: "pairing-code", access, code } }`, read `redirectTo`, extract `code`.
4. `POST {t3Url}/oauth/mcp/token` (form-encoded, PKCE verifier, `resource = {t3Url}/mcp`). Store the access token and its expiry.
5. Verify with `t3_environment_read`, then switch over.

T3 issues no refresh tokens; credentials last 30 days. The renewal job re-enrolls when fewer than `renewWhenDaysLeft` days remain (or the credential has expired), keeps the old credential until the new one is verified, and alerts in logs and `fleet_status` if renewal fails. It does not enroll hosts that were never enrolled; `serve` logs `host.not_enrolled` for those.

The T3 client keeps one MCP session per host, shared by every call to that host (watcher, dispatcher, health probes, agent actions). It replaces the session only after a session-level failure (a connection error or closed transport, a failure while connecting, `404` session lost, `401`/`403` or another `4xx`) or a credential change. A request timeout or a `5xx` answer fails only that call: closing the session would also fail every other call in flight on it, for example a launch whose response would then be lost. Each connection has a generation number, so a failure observed on an older connection never closes a newer one. A `404` (T3 forgot the session, so it never handled the call) is retried once on a new session. Other transport failures are retried once only for read-only tools; for state-changing tools a lost response is ambiguous, and the job layer must record it as `unknown` rather than retry. Old T3 sessions expire on their own; the operator can revoke them in T3's Settings → Connections.

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
- Graceful shutdown: stop accepting, finish in-flight requests, persist watcher state. As built: the HTTP server drains (up to 10 seconds), then the job engine stops after its current tick (a launch in progress completes or times out), then renewal stops and the database closes. Every job change is written when it happens, so there is nothing else to persist; a job left `dispatching` by a crash is reconciled at the next start.

## Testing

- Unit: config validation, OAuth flows (registration rules, PKCE, code reuse, refresh rotation, reuse detection and grace window, expiry, revocation, throttling), job state machine, idempotency, reconciliation decisions.
- Integration: the gateway against a fake T3 MCP server built with the SDK that implements the T3 tools the gateway uses and supports failure injection (lost launch response, timeouts, pending requests, unreachable host). Includes restart recovery: stop the gateway mid-job, start it again, the same job continues.
- Agent path: an SDK client that performs registration, approval with a minted code, token exchange, refresh, and tool calls, including a request without `MCP-Protocol-Version`.
- Live end-to-end against a real T3 server: a script outside the automated suite, run against a scratch project. As built: `scripts/e2e-live.ts` (see `docs/operations.md`). The fake T3 (`test/helpers/fakeT3.ts`) implements the thread and pending-request tools from T3's published input and output schemas, with strict inputs so a misspelled field fails a test, and injects tool errors, delays, lost responses and bare HTTP statuses.

## Decisions log

- Gateway terminates MCP itself instead of proxying T3's MCP: agents get a small job-level contract, and client quirks are absorbed by our server.
- Downstream access level defaults to T3 "auto" (Full access) because the gateway enforces its own scopes and per-project runtime modes.
- Polling instead of webhooks: T3 has no completion webhooks; the gateway is always on.
- v2 MCP SDK split packages over 1.x: current stable line, far fewer dependencies, serves both protocol eras (see Runtime).
- Own OAuth server on `node:http` instead of SDK helpers: v2 freezes its authorization-server helpers in a legacy package, and the rules here (approval codes, family revocation, grace window) need custom logic anyway.
- `/mcp` sets the `Accept` header of every POST to `application/json, text/event-stream` before the SDK transport sees it: the gateway always answers JSON, and the transports would otherwise refuse clients that send only `application/json` or a wildcard with `406`.
- 2025-era requests get a per-request stateless transport with JSON responses instead of the SDK handler's SSE-only legacy fallback, matching the JSON responses T3 itself sends to the same clients.
- Refresh grace window semantics: a retry of a rotated refresh token within two minutes gets a sibling pair and leaves the earlier sibling valid, because MCP clients refresh without a lock (two requests that both get a 401 both refresh) and keep whichever pair they saved last; retiring the first pair would log such a client out. Theft detection is kept by superseding the other siblings once one is rotated: presenting a superseded token, a rotated token after the grace window, or a token whose child was already rotated revokes the family. (Changed in round C; round A retired the earlier pair.)
- Global OAuth throttles are recoverable by the operator (minting a code lifts the approval pause; unapproved registrations stop counting after 10 minutes; `throttle reset`), because unauthenticated parties can fill them. Unapproved clients are still pruned only after a day, not after 10 minutes: an agent may show its approval link to a person who opens it much later, and pruning its registration would strand it.
- The package is not published to npm: Node does not strip types under `node_modules`, so it runs from a checkout (or `npm link`).
- T3 `isError` on a launch is a definite rejection (`failed`); only transport failures can make a launch `unknown`. Unknown launches are reconciled by the title marker, never relaunched.
- Transport failures carry a delivery verdict in the T3 client rather than in the job layer, so every state-changing call (launch, send, interrupt, respond) can tell "nothing happened" from "may have happened".
- The shared T3 session is replaced only on session-level failures, never on a timeout, and resets are tied to the connection generation that failed: one slow call (such as a `fleet_status` health probe) must not lose the response of a launch in flight on the same session.
- A read-only call precedes launches so a dead keep-alive connection is discovered by a retryable read.
- `idle` frees a concurrency slot: a finished turn should not block the queue while it waits for review.
- Permission approvals stay in T3: T3's MCP tools cannot answer them, so `work_respond` handles questions and `work_status` flags `waitingForApproval`.
- Follow-ups and interrupts use T3's `clientRequestId`, so the gateway can resend after an uncertain outcome without duplicating work.
- T3 statuses are parsed as strings and unknown ones count as active, so a T3 upgrade cannot make the watcher declare work finished.
