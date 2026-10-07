# Operations

Commands below are shown as `t3-fleet-gateway`; from a checkout that is `node bin/t3-fleet-gateway.js`. Every command honours `--config`, `--data-dir`, `$T3FG_CONFIG` and `$T3FG_DATA_DIR` (see [configuration.md](configuration.md)). Commands exit `0` on success, `1` on failure and `2` on a usage error. The CLI and a running server share the database, so CLI changes take effect without a restart.

## Enroll a host

```sh
t3-fleet-gateway hosts enroll <host id>
```

Runs T3's pairing-code approval for the host (see [security.md](security.md#the-automated-t3-consent-step)): registers with T3, runs the host's `mintPairingCode` command, approves with the configured `access`, exchanges the code, verifies the credential with `t3_environment_read`, and stores it. It prints the T3 version and the expiry, never the credential.

Re-running it replaces the credential (the old one keeps working until it expires or you revoke it in T3). Common failures:

- `pairing_command_failed`: the command exited nonzero or did not print JSON with `credential`. Run it by hand; make sure it includes `--json` and that `t3` is on the service's `PATH`.
- `enrollment_failed`: T3 rejected the approval or the new credential did not verify.
- `host_unreachable`: nothing answered at `t3Url`.

## Check host credentials

```sh
t3-fleet-gateway hosts status
```

For each host: reachability and T3 version (checked live), credential state (`missing`, `active`, `renewal_due`, `expired`) with its expiry, and the last renewal failure if there is one. If T3 answers but refuses the stored credential (for example after its session was revoked in T3), the credential shows as `rejected by T3` with the error; run `hosts enroll <id>` again. Agents see the same as `credential.state: "rejected"` in `fleet_status`.

## Connect an agent

1. Add `https://<publicUrl>/mcp` as a remote MCP server in the agent.
2. When the agent opens the approval page, mint a code on the gateway machine:

   ```sh
   t3-fleet-gateway pair            # valid 15 minutes
   t3-fleet-gateway pair --ttl 1h   # 1m to 24h
   ```

3. Enter the code, choose **Read** or **Operate**, approve.

Codes work once. Five wrong codes lock that approval page (start again from the agent); twenty failures in an hour pause all approvals until the hour clears. Minting a new code with `pair` lifts that pause at once, and `pair` says so when it does.

## Throttles

Registration and approval are open to anyone who can reach the public URL, so both are rate-limited, and you can clear both:

| Limit | Value | Recovery |
| --- | --- | --- |
| Wrong approval codes per approval page | 5 | Start the connection again from the agent (a new page), or `throttle reset` |
| Wrong approval codes across all pages | 20 per rolling hour | Mint a code with `pair` (lifts the pause), wait for the hour, or `throttle reset` |
| Client registrations | 30 per hour; a client that has not completed an approval stops counting after 10 minutes | Wait 10 minutes, or `throttle reset` |

```sh
t3-fleet-gateway throttle status   # failed approvals and registrations counting toward the limits
t3-fleet-gateway throttle reset    # clear both, locked approval pages included
```

Throttling is logged as `oauth.approval_throttled` and `oauth.registration_throttled` (warn). Repeated throttling without you connecting an agent means someone is probing the URL: see [security.md](security.md#threats-and-mitigations).

## List and revoke agents

```sh
t3-fleet-gateway clients list
t3-fleet-gateway clients revoke <client id>
```

`list` shows each client's id, name, granted access, status (`pending` until approved, `active`, `revoked`), creation and last-use times, and the origins it redirects to. `revoke` takes effect immediately for every token the client holds; the agent must register and be approved again.

## Credential renewal

T3 credentials last 30 days. `serve` checks at startup and every `renewal.checkEveryMinutes`, and re-enrolls any host with fewer than `renewal.renewWhenDaysLeft` days left (or already expired). The old credential stays in use until the new one is verified. Failures are logged as `host.enrollment_failed`, shown by `hosts status` and `doctor`, and reported to agents in `fleet_status` as `credential.renewalError`; the next check retries. Hosts that were never enrolled are not enrolled automatically (`serve` logs `host.not_enrolled` at startup).

## Jobs

Agents with **Operate** start work with `work_start`; the gateway queues the job, creates a T3 thread titled `<title> [job:<id>]` in a fresh worktree on branch `<branchPrefix><id>` (from the project's `baseRef`), and follows it. What to know as the operator:

- **Find a job in T3** by searching for its id or `[job:<id>]`. Every job is an ordinary thread: read it, type into it, stop it. If you stop it, the job becomes `idle` (the agent can continue it); if you type into an idle job's thread, the gateway records the extra turn.
- **Approvals.** Threads run with the project's `runtimeMode`. With `approval-required`, permission approvals wait for you in T3; the job shows `needs_input` with `waitingForApproval` and agents cannot answer it. Worker questions (not approvals) can be answered by agents with `work_respond`.
- **Concurrency.** At most `maxConcurrentJobs` jobs per host hold a slot (`dispatching`, `running`, `needs_input`, `cancel_requested`, `unknown`); the rest wait as `queued`. `fleet_status` shows the counts. An `idle` job holds no slot.
- **Host down.** Jobs keep their state; `work_status` shows `hostUnreachableSince` and the gateway retries with backoff (up to every 5 minutes). Queued jobs launch when the host is back.
- **Unknown launches.** If a launch's response is lost, the job is `unknown` and the gateway looks for `[job:<id>]` in the project's threads. Found: it continues. Not found for `watcher.reconcileWindowMinutes` (default 10) while the host answers: `failed` with `launch_not_confirmed`. The gateway never launches twice; the agent decides whether to start again.
- **Cleanup.** Cancelled, failed and finished jobs leave their T3 thread, worktree and branch in place for you. Remove them in T3 or with git when you no longer need them.
- **Restarts** are safe at any time: job state is in the database, and the next start resumes watching every unfinished job and reconciles any launch that was in flight.

## Doctor

```sh
t3-fleet-gateway doctor
```

Checks, in order: the config, data directory permissions, database integrity and schema version, each host's credential and live reachability, that each project resolves to a T3 project, and that `publicUrl` serves this gateway's protected resource metadata (which needs `serve` and the tunnel running). Each line is `OK`, `WARN` or `FAIL`; any `FAIL` exits `1`.

## Run as a service

macOS (launchd, per-user agent with KeepAlive):

```sh
deploy/launchd/install.sh --dry-run   # print the plist it would install
deploy/launchd/install.sh             # install and load
deploy/launchd/install.sh --uninstall # unload and remove the plist
```

The installer fills in absolute paths and puts the directories of `node` and `t3` on the service's `PATH`. Override any default with environment variables: `LABEL`, `REPO_DIR`, `NODE_BIN`, `T3_BIN`, `CONFIG_PATH`, `DATA_DIR`, `LOG_DIR`, `PLIST_DIR`.

Linux (systemd user unit): see the comments at the top of [`deploy/systemd/t3-fleet-gateway.service`](../deploy/systemd/t3-fleet-gateway.service).

On `SIGINT` or `SIGTERM` the gateway stops accepting connections, finishes in-flight requests (up to 10 seconds), lets the job engine finish its current tick, stops the renewal loop and closes the database. Job state is written as it changes, so nothing is lost; a launch interrupted by a crash is reconciled at the next start.

## Logs

`serve` writes JSON lines to standard output (launchd: `~/Library/Logs/t3-fleet-gateway/gateway.log` by default; systemd: `journalctl --user -u t3-fleet-gateway`). Set `T3FG_LOG_LEVEL=debug` for more detail. Useful events:

| Event | Meaning |
| --- | --- |
| `gateway.started`, `gateway.stopped` | Lifecycle |
| `oauth.client_registered`, `oauth.approval_granted`, `oauth.approval_denied` | Agent onboarding |
| `oauth.approval_failed`, `oauth.approval_throttled`, `oauth.registration_throttled` (warn) | Wrong codes; throttling engaged (see Throttles) |
| `oauth.token_issued`, `oauth.refresh_retry_accepted` | Token issue and rotation |
| `oauth.token_family_revoked` (warn) | Refresh token or code replay: a grant was revoked |
| `mcp.tool_call` | Tool name, client id, outcome, error code, duration |
| `mcp.unauthorized`, `mcp.origin_rejected` | Rejected `/mcp` requests |
| `host.enrollment_succeeded`, `host.enrollment_failed`, `host.renewal_due`, `host.not_enrolled` | T3 credentials |
| `job.created`, `job.state_changed` | Job id, project, host, client id; `from`, `to`, `reason`, `errorCode` |
| `jobs.host_unreachable` (warn), `jobs.host_reachable` | The job engine lost or regained a host; jobs keep their state |
| `jobs.reconcile_failed`, `jobs.watch_failed`, `jobs.interrupt_failed`, `jobs.interrupt_deferred` (warn) | A T3 call for one job failed (job id, error code); the error is on the job and the call is retried next tick |
| `jobs.tick_failed`, `jobs.host_tick_failed` (error) | Unexpected engine errors (with an error code and, per host, the step); the next step still runs |
| `http.request` | Method, path (no query), status, duration |

Logs never contain tokens, codes, authorization headers, task text or message content.

## Live end-to-end check

`scripts/e2e-live.ts` checks a running gateway against a real T3 host the way an agent would. It is not part of `npm test`. It registers a client, gets approved for **Operate** with a code you mint, exchanges the code, calls `fleet_status`, then:

1. starts job A in a project with a tiny harmless task (reply `READY`, no commands, no file changes) and polls `work_feed` until it is `idle`;
2. checks `work_status` (thread, excerpt), sends a follow-up with `work_continue` (reply `DONE`) and polls until `idle` again;
3. starts job B, waits until it runs, cancels it with `work_cancel` and waits for `cancelled`;
4. cancels job A to leave nothing active.

It prints one `PASS`/`FAIL`/`INFO` line per step with job ids, states and reasons only (never tokens, codes or worker text; excerpts are reported by length), ends with `E2E PASS` or `E2E FAIL`, and exits `0` or `1`.

Use a scratch project: each run leaves two T3 threads with their worktrees and branches. With the gateway running (`serve`) and the host enrolled:

```sh
t3-fleet-gateway pair                    # mint an approval code
T3FG_E2E_APPROVAL_CODE=XXXXX-XXXXX \
T3FG_E2E_PROJECT=pilot \
  node scripts/e2e-live.ts --config /path/to/config.json
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3FG_E2E_APPROVAL_CODE` | required | A code from `pair`; it is used once and never printed |
| `T3FG_E2E_PROJECT` | the first configured project | Project alias to run the jobs in |
| `T3FG_E2E_URL` | `publicUrl` | Gateway base URL, for example `http://127.0.0.1:3790` to bypass the tunnel |
| `T3FG_E2E_TIMEOUT_SECONDS` | `600` | How long to wait for each job transition |
| `T3FG_E2E_POLL_SECONDS` | `5` | Delay between `work_feed` polls |

`--config` (or `$T3FG_CONFIG`) is read for `publicUrl` and the project list only. If a job reaches `needs_input` (for example an approval under `approval-required`), the script says so and keeps waiting until the timeout, so you can approve it in T3. Each run registers a new agent client; remove old ones with `clients revoke`.

## Backup and restore

Everything is in the data directory. With the gateway stopped, copy the whole directory (keep its `0700`/`0600` permissions), or while running use SQLite's online backup:

```sh
sqlite3 ~/.local/share/t3-fleet-gateway/gateway.db ".backup '/path/to/backup/gateway.db'"
cp -p ~/.local/share/t3-fleet-gateway/gateway.key /path/to/backup/
```

Treat backups as secrets: they contain T3 credentials. To restore, stop the gateway, put both files back in the data directory with mode `0600`, and start it. Without `gateway.key`, existing agent connections keep working but unused approval codes become invalid.

## Uninstall

1. Stop and remove the service (`deploy/launchd/install.sh --uninstall`, or `systemctl --user disable --now t3-fleet-gateway`).
2. Revoke the gateway's T3 sessions: in T3 under Settings → Connections, or `t3 auth session list --json` and `t3 auth session revoke <id>` for sessions labelled `t3-fleet-gateway (<host id>)`.
3. Remove the agent connection in each agent.
4. Delete the data directory, the config file and the logs.
