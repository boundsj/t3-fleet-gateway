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

**Someone on the internet finds your public URL.** Registration is open (OAuth dynamic registration requires it), but registering grants nothing. Getting a token needs approval with a one-time code that only exists on the gateway machine. Codes are 50 bits of randomness, expire (15 minutes by default), work once, and failed attempts are throttled: 5 per authorization request, then that request is locked, and 20 per rolling hour across all requests, after which all approvals pause until the hour clears. Throttle events are logged. Registration itself is limited to 30 clients per hour, and clients that never complete an approval are deleted after a day.

**A malicious page tricks you into approving.** The approval page shows the client name, the full origin it will redirect to, and the requested access; read them before approving. The form is bound to the exact request by an HMAC with a server key and expires after 10 minutes, so its hidden fields (redirect URI, PKCE challenge, state) cannot be swapped. Redirect URIs must match a registered one exactly and must be `https` (or `http` to a loopback host); the gateway never redirects to an unregistered URI. The page loads no external resources, forbids framing, and has a strict Content Security Policy.

**An authorization code is intercepted.** Codes live 60 seconds, need the PKCE verifier (S256 only), and work once. Replaying a used code revokes every token issued from it.

**A refresh token is stolen.** Refresh tokens rotate on every use. Presenting an already-rotated refresh token more than two minutes after its rotation, or after its successor has been used, revokes the whole token family (all access and refresh tokens from that approval), which logs out both the thief and the client; the agent must be approved again. The two-minute grace window lets a client retry a refresh whose response it lost; the retry retires the pair it never received. Unused refresh tokens expire after `refreshIdleTtlDays`.

**The database leaks.** Agent access tokens, refresh tokens and authorization codes are random 256-bit values stored only as SHA-256 hashes. Approval codes are stored as HMACs keyed with `gateway.key`, so a leaked database alone cannot be brute-forced offline for codes. T3 credentials are the exception (see below).

**DNS rebinding or a browser on the gateway machine.** Everything listens on loopback. `/mcp` rejects requests whose `Origin` header is present and not `publicUrl` (or listed in `allowedOrigins`); clients that send no `Origin` (server-to-server agents) are unaffected. Every `/mcp` request needs a bearer token, which a browser page cannot obtain. The gateway does not validate the `Host` header, because tunnels differ in what they forward and no endpoint grants anything based on network position alone.

**Oversized or malformed input.** Request bodies are bounded (16 KiB for OAuth endpoints, 1 MiB for `/mcp`), strings in registration are length-limited, and tool inputs are validated against schemas: tasks and follow-ups at most 20,000 characters, answers at most 16,000 characters of JSON, list and feed pages at most 100 and 200 items.

**An Operate agent misbehaves.** It can start and steer work only in the configured projects, each job in its own worktree and branch, at the project's `runtimeMode` (capped by the host's `access`), and at most `maxConcurrentJobs` per host at once; more jobs wait in the queue, which you can see with `work_list` or in `fleet_status`. Every job is an ordinary T3 thread you can read and stop. Revoke the client to cut it off.

## What is stored, and where

All state is in the data directory (default `~/.local/share/t3-fleet-gateway/`, mode `0700`; files `0600`). The gateway refuses to start if permissions are looser.

| Data | Where | Form |
| --- | --- | --- |
| Registered agent clients (name, redirect URIs, timestamps) | `gateway.db` | plain |
| Approval codes | `gateway.db` | HMAC-SHA256, single use |
| Authorization codes, access tokens, refresh tokens | `gateway.db` | SHA-256 hashes |
| T3 credentials, one per host | `gateway.db` `host_credentials` | **plain bearer tokens** (the gateway must present them) |
| HMAC key | `gateway.key` | 32 random bytes |
| Jobs: task text, thread titles, the latest worker message excerpt (at most 2,000 characters), pending question ids | `gateway.db` `jobs` | plain, never logged |
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
