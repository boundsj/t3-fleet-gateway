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

For each host: reachability and T3 version (checked live), credential state (`missing`, `active`, `renewal_due`, `expired`) with its expiry, and the last renewal failure if there is one.

## Connect an agent

1. Add `https://<publicUrl>/mcp` as a remote MCP server in the agent.
2. When the agent opens the approval page, mint a code on the gateway machine:

   ```sh
   t3-fleet-gateway pair            # valid 15 minutes
   t3-fleet-gateway pair --ttl 1h   # 1m to 24h
   ```

3. Enter the code, choose **Read** or **Operate**, approve.

Codes work once. Five wrong codes lock that approval page (start again from the agent); twenty failures in an hour pause all approvals until the hour clears.

## List and revoke agents

```sh
t3-fleet-gateway clients list
t3-fleet-gateway clients revoke <client id>
```

`list` shows each client's id, name, granted access, status (`pending` until approved, `active`, `revoked`), creation and last-use times, and the origins it redirects to. `revoke` takes effect immediately for every token the client holds; the agent must register and be approved again.

## Credential renewal

T3 credentials last 30 days. `serve` checks at startup and every `renewal.checkEveryMinutes`, and re-enrolls any host with fewer than `renewal.renewWhenDaysLeft` days left (or already expired). The old credential stays in use until the new one is verified. Failures are logged as `host.enrollment_failed`, shown by `hosts status` and `doctor`, and reported to agents in `fleet_status` as `credential.renewalError`; the next check retries. Hosts that were never enrolled are not enrolled automatically (`serve` logs `host.not_enrolled` at startup).

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

On `SIGINT` or `SIGTERM` the gateway stops accepting connections, finishes in-flight requests (up to 10 seconds), stops the renewal loop and closes the database.

## Logs

`serve` writes JSON lines to standard output (launchd: `~/Library/Logs/t3-fleet-gateway/gateway.log` by default; systemd: `journalctl --user -u t3-fleet-gateway`). Set `T3FG_LOG_LEVEL=debug` for more detail. Useful events:

| Event | Meaning |
| --- | --- |
| `gateway.started`, `gateway.stopped` | Lifecycle |
| `oauth.client_registered`, `oauth.approval_granted`, `oauth.approval_denied` | Agent onboarding |
| `oauth.approval_failed`, `oauth.approval_throttled` (warn) | Wrong codes; throttling engaged |
| `oauth.token_issued`, `oauth.refresh_retry_accepted` | Token issue and rotation |
| `oauth.token_family_revoked` (warn) | Refresh token or code replay: a grant was revoked |
| `mcp.tool_call` | Tool name, client id, outcome, error code, duration |
| `mcp.unauthorized`, `mcp.origin_rejected` | Rejected `/mcp` requests |
| `host.enrollment_succeeded`, `host.enrollment_failed`, `host.renewal_due`, `host.not_enrolled` | T3 credentials |
| `http.request` | Method, path (no query), status, duration |

Logs never contain tokens, codes, authorization headers, task text or message content.

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
