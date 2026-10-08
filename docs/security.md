# Security

This document covers the threat model, what the gateway stores and where, and how it obtains access to T3 on your behalf. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What the gateway protects

The gateway can make T3 Code start and steer coding agents on your machines. A stolen agent token with the `fleet:operate` scope is roughly equivalent to being able to type instructions into T3 at the gateway host's configured `access` level. The design keeps that power behind a human approval and narrow, revocable credentials.

## Trust boundaries

| Party | Trusted with |
| --- | --- |
| You (the operator) | Everything. You run the CLI on the gateway machine. |
| The gateway machine | The SQLite database, the HMAC key and T3 credentials. Anyone who can read the data directory as your user can act as the gateway. |
| Your tunnel | Transport only. It terminates TLS and forwards to `127.0.0.1`. It never sees anything but HTTPS requests and responses. |
| Agents (Grok Bot and other MCP clients) | Only what you approved: `fleet:read`, or `fleet:read fleet:operate`. They never see T3 credentials. |
| T3 Code servers | Their own data. T3 never sees agent tokens. |

## Threats and mitigations

**Someone on the internet finds your public URL.** Registration is open (OAuth dynamic registration requires it), but registering grants nothing. Getting a token needs approval with a one-time code that only exists on the gateway machine. Codes are 50 bits of randomness, expire (15 minutes by default), work once, and failed attempts are throttled: 5 per authorization request, then that request is locked, and 20 per rolling hour across all requests, after which all approvals pause until the hour clears or you mint a new code. Registration itself is limited to 30 clients per hour; a client that has not completed an approval stops counting after 10 minutes, and clients that never complete one are deleted after a day. Throttle events are logged.

**Someone exhausts the throttles to lock you out.** Both global limits can be filled by anyone who can reach the public URL, so both are recoverable by you. `t3-fleet-gateway pair` starts a fresh approval-failure window whenever it mints a code (it says so when approvals were paused); 20 more guesses against a 50-bit code are negligible. Unapproved registrations stop counting after 10 minutes, so a burst of junk registrations blocks new ones for at most that long, and `t3-fleet-gateway throttle reset` clears both limits at once, including locked approval pages. `throttle status` shows how full they are. An attacker who keeps registering faster than the limit allows can still keep registration saturated; the gateway has no per-source limit, because the tunnel in front of it may not forward client addresses. If that happens, find the source in your tunnel's logs and block it there.

**A malicious page tricks you into approving.** The approval page shows the client name, the full origin it will redirect to, and the requested access; read them before approving. The form is bound to the exact request by an HMAC with a server key and expires after 10 minutes, so its hidden fields (redirect URI, PKCE challenge, state) cannot be swapped. Redirect URIs must match a registered one exactly and must be `https` (or `http` to a loopback host); the gateway never redirects to an unregistered URI. The one relaxation is RFC 8252 section 7.3: an `http` loopback URI matches with any port, because native clients listen on a port chosen at request time; scheme, host, path and query must still match exactly. The page loads no external resources, forbids framing, and has a strict Content Security Policy.

**The approval form never redirects.** Browsers apply a page's `form-action` to every redirect that follows a form submission, and block a disallowed one silently: an approval that answered with a redirect to the client's callback, whose own redirect led to another origin, left the operator on the approval page. So the form answers with a small page instead (same headers, no script) that navigates to the authorization response by meta refresh and shows a Continue link to it; denials and request errors go the same way. `form-action` stays `'self'`, and no directive in the policy restricts navigation. The page carries `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the authorization code in its URL is not sent as a Referer to the callback and is not cached. Submitting an approved form again (a double click, or Back and resubmit) shows the same response, as a link, while its code is unused and unexpired; the gateway keeps that URL, code included, in memory only until the code expires (60 seconds), and the fact of the approval until the form expires. A repeated form never gets a new code, spends no approval code and counts as no failed attempt. Only someone holding the signed form can repeat it, and the code is useless without the client's PKCE verifier.

**An authorization code is intercepted.** Codes live 60 seconds, need the PKCE verifier (S256 only), and work once. Replaying a used code revokes every token issued from it.

**A refresh token is stolen.** Refresh tokens rotate on every use. Presenting an already-rotated refresh token more than two minutes after its rotation, or after a token issued from it has itself been rotated, revokes the whole token family (all access and refresh tokens from that approval), which logs out both the thief and the client; the agent must be approved again. Within the two-minute grace window a rotated token gets another pair, so a client that lost a response, or sent two refreshes at once (MCP clients refresh without a lock), is never logged out: both pairs work. As soon as the client rotates one of those sibling pairs, the others are superseded, and presenting a superseded refresh token revokes the family. Unused refresh tokens expire after `refreshIdleTtlDays`.

*Residual risk: a superseded sibling's access token stays valid until it expires* (`accessTtlSeconds`, 12 hours by default). A thief who presents a stolen refresh token inside the grace window gets a sibling pair; its refresh token becomes useless once the client rotates (presenting it revokes the family), but its access token keeps working until it expires. The gateway does not revoke it when the sibling is superseded. That does not spare a legitimate holder of the pair: if two processes of one agent refresh at once and each keeps the pair it received, the process whose pair is superseded is logged out anyway once its access token expires, because its next refresh presents a superseded refresh token and revokes the family for both (accepting that refresh instead would give a thief the same way back in). Not revoking only delays that logout, and the delay is symmetric: a thief holding a superseded sibling gets the same window. The gateway keeps this behavior, so the benign race does not cut a working process off mid-task. If you prefer the stricter side, lower `accessTtlSeconds`, which shortens both the delay and the thief's window; to close the window at once, revoke the client with `clients revoke`. Agents should keep one token store per registered client, as MCP clients do: a process that keeps a superseded pair in memory and later refreshes with it revokes the family whether or not the access token was revoked.

**The database leaks.** Agent access tokens, refresh tokens and authorization codes are random 256-bit values stored only as SHA-256 hashes. Approval codes are stored as HMACs keyed with `gateway.key`, so a leaked database alone cannot be brute-forced offline for codes. T3 credentials are the exception (see below).

**DNS rebinding or a browser on the gateway machine.** Everything listens on loopback. `/mcp` rejects requests whose `Origin` header is present and not `publicUrl` (or listed in `allowedOrigins`); clients that send no `Origin` (server-to-server agents) are unaffected. Every `/mcp` request needs a bearer token, which a browser page cannot obtain. The gateway does not validate the `Host` header, because tunnels differ in what they forward and no endpoint grants anything based on network position alone.

**Oversized or malformed input.** Request bodies are bounded (16 KiB for OAuth endpoints, 1 MiB for `/mcp`), strings in registration are length-limited, and tool inputs are validated against schemas: tasks and follow-ups at most 20,000 characters, answers at most 16,000 characters of JSON, list and feed pages at most 100 and 200 items.

**An Operate agent misbehaves.** It can start and steer work only in the configured projects, each job in its own worktree and branch, at the project's `runtimeMode` (capped by the host's `access`), and at most `maxConcurrentJobs` per host at once; more jobs wait in the queue, which you can see with `work_list` or in `fleet_status`. Every job is an ordinary T3 thread you can read and stop. Revoke the client to cut it off.

## Known limitations

- **No CORS on registration and token endpoints.** `/oauth/register` and `/oauth/token` send no CORS headers, so an MCP client running as a web page in a browser cannot complete sign-in. Server-side agents (Grok Bot and other hosted or native clients) are unaffected; the metadata documents do allow any origin.
- **No per-source rate limits.** The OAuth throttles are global (see above), because the tunnel in front of the gateway may not forward client addresses.

## What is stored, and where

All state is in the data directory (default `~/.local/share/t3-fleet-gateway/`, mode `0700`; files `0600`). The gateway refuses to start if permissions are looser.

| Data | Where | Form |
| --- | --- | --- |
| Registered agent clients (name, redirect URIs, timestamps) | `gateway.db` | plain |
| Approval codes | `gateway.db` | HMAC-SHA256, single use |
| Authorization codes, access tokens, refresh tokens | `gateway.db` | SHA-256 hashes |
| T3 credentials, one per host | `gateway.db` `host_credentials` | **plain bearer tokens** (the gateway must present them) |
| HMAC key | `gateway.key` | 32 random bytes |
| Jobs: task text, thread titles and app links, the latest worker message excerpt (at most 2,000 characters), pending question ids | `gateway.db` `jobs` | plain, never logged |
| Full worker messages (`work_messages`) | not stored: read from T3 when an agent asks, returned to agents with Read access, never logged | — |
| Job events (state changes with gateway-generated reasons and codes; no content) | `gateway.db` `job_events` | plain, append-only |
| Request ids of `work_start` and `work_continue` with an input hash | `gateway.db` `idempotency_keys` | SHA-256 of the input |

Back up the data directory as a secret. Anyone who can read it can call T3 with the stored credentials until they expire or you revoke them in T3.

## Logs

Logs are JSON lines on standard output. They contain event names, ids (client ids, token family ids, host ids, job ids), states, tool names, HTTP methods, paths without query strings, status codes and durations. They never contain tokens, approval or pairing codes, authorization headers, task text or worker message content. The logger also replaces values under secret-bearing keys (`token`, `code`, `authorization`, `credential`, `task`, `message` and similar) as a backstop, and automated tests drive a full OAuth flow, MCP calls and an enrollment, and every job tool with distinctive task, follow-up, question, answer and worker text, and assert that none of it appears in the captured logs.

## The automated T3 consent step

T3 Code normally approves a new MCP client in a browser: you see the client and choose an access level. T3 also supports approving with a one-time **pairing code** minted by its CLI. The gateway uses that path so it never needs a browser:

1. It registers an OAuth client with T3 named `t3-fleet-gateway (<host id>)`, with a loopback redirect URI that is never followed.
2. It runs the host's `mintPairingCode` command (by default `t3 auth pairing create --ttl 5m --json`), reads the code from its output and never logs it.
3. It submits the approval decision to T3 with that code and the configured `access` level, then exchanges the resulting authorization code (with PKCE) for a T3 access token.
4. It verifies the new credential by calling `t3_environment_read`, and only then stores it.

This automates T3's consent step using **your own access to the machine**: the same access needed to run `t3 auth pairing create`. It grants nothing you could not grant yourself, but it does mean the gateway can renew its own access every month without asking. Keep that in mind when choosing `access`:

- `read-only` lets the gateway read T3 state only (enough for `fleet_status`).
- `approval-required` through `full-access` let it start threads, with T3 capping their runtime mode at that level. The gateway adds its own scopes and per-project `runtimeMode` on top.

T3 issues no refresh tokens; credentials last 30 days. The renewal loop re-enrolls a host when fewer than `renewWhenDaysLeft` days remain and keeps the old credential until the new one is verified. Old T3 sessions expire on their own; you can revoke them earlier in T3 under Settings → Connections, or with `t3 auth session list` and `t3 auth session revoke <id>`.

## Revocation

- One agent: `t3-fleet-gateway clients revoke <client id>` revokes the client and every token issued to it, immediately, without a restart.
- The gateway's access to a T3 host: revoke its session in T3 (Settings → Connections, or `t3 auth session revoke`), and remove the host from the config or stop the gateway, since renewal would otherwise enroll again.
- Everything: stop the gateway and delete the data directory, then revoke its T3 sessions.
