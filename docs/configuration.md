# Configuration

The gateway reads one JSON file and keeps its state in one data directory. Nothing machine-specific lives in the repository; start from [`config.example.json`](../config.example.json).

## Locations

| What | Default | Override |
| --- | --- | --- |
| Config file | `~/.config/t3-fleet-gateway/config.json` | `$T3FG_CONFIG` or `--config <path>` |
| Data directory | `~/.local/share/t3-fleet-gateway/` | `$T3FG_DATA_DIR` or `--data-dir <path>` |
| Log level (`debug`, `info`, `warn`, `error`) | `info` for `serve`, off for other commands | `$T3FG_LOG_LEVEL` |

The data directory is created with mode `0700` and holds `gateway.db` (SQLite, with its `-wal` and `-shm` files) and `gateway.key` (32 random bytes used for HMACs), all mode `0600`. Every command refuses to run if the directory or any of those files is accessible to group or others, and prints the `chmod` that fixes it.

## Validation

The file is validated on every start. Unknown keys are errors, so typos surface. Errors name the exact field:

```
error (config_invalid): Invalid configuration:
  hosts[0].t3Url: t3Url must use https (http is allowed only for loopback hosts)
  projects[1].host: unknown host "mni"
```

## Fields

### `publicUrl` (required)

The HTTPS origin agents use, for example `https://gateway.example.ts.net` or `https://gateway.example.ts.net:8443`. Origin only: no path, query or fragment. The OAuth issuer, endpoints and the MCP resource (`<publicUrl>/mcp`) are derived from it, and tokens are bound to that resource. Plain `http` is accepted only for loopback hosts (local testing).

### `listen`

`{ "host": "127.0.0.1", "port": 3790 }` by default. The host must be a loopback address (`127.0.0.1`, `::1` or `localhost`): expose the gateway through your tunnel, not directly.

### `allowedOrigins`

Default `[]`. Browser-based MCP clients send an `Origin` header; the gateway accepts requests with no `Origin` (server-to-server clients such as Grok Bot) or with an `Origin` equal to `publicUrl` or listed here. Add an origin only if a browser-based client you trust needs it.

### `hosts` (required, at least one)

Each entry is a machine running a T3 Code server.

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Short stable id (lowercase letters, digits, hyphens; up to 32). Used in project config, CLI commands and tool output. |
| `label` | none | Human-friendly name shown in `fleet_status`. |
| `t3Url` | required | T3 server origin. `http` only for loopback; `https` for remote hosts. |
| `mintPairingCode` | `["t3","auth","pairing","create","--ttl","5m","--json"]` | Command (argv, no shell) that prints a T3 pairing code as JSON with a `credential` field. For a remote host use something like `["ssh","other-host","t3","auth","pairing","create","--ttl","5m","--json"]`. Adding `--label t3-fleet-gateway` makes the pairing easy to spot in T3. |
| `access` | `"auto"` | The T3 approval level the gateway requests: `read-only`, `approval-required`, `auto-accept-edits`, `auto` or `full-access`. T3 also treats it as the ceiling for the runtime mode of threads the gateway starts. |
| `maxConcurrentJobs` | `2` | Jobs running at once on this host (used by the planned job layer). |

### `projects`

What agents can target. Each entry:

| Field | Default | Meaning |
| --- | --- | --- |
| `alias` | required | The name agents use (lowercase letters, digits, `.`, `_`, `-`). |
| `description` | `""` | Shown to agents in `fleet_status`. |
| `host` | required | A host `id`. |
| `t3ProjectId` or `t3ProjectTitle` | exactly one required | The T3 project, by id or by exact title. `doctor` checks that it resolves. |
| `baseRef` | `"main"` | Branch or ref each job's worktree starts from. |
| `branchPrefix` | `"fleet/"` | Job branches are `<branchPrefix><jobId>`. |
| `runtimeMode` | `"approval-required"` | T3 runtime mode for job threads: `approval-required`, `auto-accept-edits`, `auto` or `full-access`. Must not exceed the host's `access`; projects cannot be placed on a `read-only` host. Choose looser modes per project deliberately. |
| `modelSelection` | `null` | Optional T3 `modelSelection` object (must contain `model`). |

`baseRef`, `branchPrefix`, `runtimeMode`, `modelSelection` and `maxConcurrentJobs` are validated now and take effect with the job layer.

### `tokens`

| Field | Default | Range |
| --- | --- | --- |
| `accessTtlSeconds` | `43200` (12 h) | 60 s to 7 days |
| `refreshIdleTtlDays` | `90` | 1 to 365. A refresh token not used for this long expires; each use rotates it and restarts the clock. |

### `renewal`

| Field | Default | Meaning |
| --- | --- | --- |
| `renewWhenDaysLeft` | `5` | Re-enroll a host when its T3 credential has fewer days left than this (T3 credentials last 30 days). |
| `checkEveryMinutes` | `60` | How often `serve` checks. It also checks once at startup. |

### `watcher`

`{ "pollSeconds": 10 }`: how often the planned job watcher polls T3. Validated now, used with the job layer.

## A remote host

```json
{
  "id": "studio",
  "label": "Studio workstation",
  "t3Url": "https://studio.example.ts.net:3773",
  "mintPairingCode": ["ssh", "studio", "t3", "auth", "pairing", "create", "--ttl", "5m", "--label", "t3-fleet-gateway", "--json"],
  "access": "auto"
}
```

Then run `t3-fleet-gateway hosts enroll studio`. Adding a host is configuration plus enrollment.
