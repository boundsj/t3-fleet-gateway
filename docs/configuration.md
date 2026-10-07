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
| `access` | `"auto"` | The T3 approval level the gateway requests when it enrolls: `read-only`, `approval-required`, `auto-accept-edits`, `auto` or `full-access`. T3 treats it as the ceiling for the runtime mode of threads the gateway starts, so a project's `runtimeMode` may not exceed it. Changing it takes a new `hosts enroll`. |
| `maxConcurrentJobs` | `2` (1 to 32) | Jobs holding a slot at once on this host: `dispatching`, `running`, `needs_input`, `cancel_requested` and `unknown` count; `idle` does not. Further jobs wait as `queued`, first in, first out. |
| `defaultModelSelection` | `null` | T3 `modelSelection` object (must contain `model`) for launches in projects on this host that set no `modelSelection` of their own, for example `{ "instanceId": "codex", "model": "<model id>" }`. T3's `orchestrator_capabilities` tool lists the provider instances and models. |

Which `access` to choose: the host's `access` is only a ceiling. What a job may do without asking is decided per project by `runtimeMode`, which defaults to `approval-required`. [`config.example.json`](../config.example.json) therefore enrolls the host with `full-access`, so any project on it can be given a looser mode later without re-enrolling, and keeps its project at `approval-required`. Use a lower `access` if you want the host itself to rule out looser modes.

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
| `runtimeMode` | `"approval-required"` | T3 runtime mode for job threads: `approval-required`, `auto-accept-edits`, `auto` or `full-access`. Must not exceed the host's `access`; projects cannot be placed on a `read-only` host. See "Approvals and unattended projects" below. |
| `modelSelection` | `null` | T3 `modelSelection` object (must contain `model`) for this project's launches. Without it the host's `defaultModelSelection` is used, and without that the T3 project's own default model. |
| `allowWorkStart` | `true` | Whether agents may start new jobs here with `work_start`. Set `false` for a project run by a standing coordinator thread: `work_start` then fails with `start_disabled`, naming the project's standing jobs, and agents send work to those with `work_continue`. See "Projects with a coordinator" below. |

#### Models

T3 refuses to launch a thread without a model when the T3 project has no default model (`invalid_request`: "Pass modelSelection: the project has no default model"), and every job in that project then fails at once. Set `modelSelection` on the project or `defaultModelSelection` on its host, or give the project a default model in T3. `doctor` reports `FAIL` for a project that would have no model, `serve` logs `project.model_missing` at startup, and `fleet_status` shows agents `modelConfigured: false` for projects that rely on T3's default.

#### Approvals and unattended projects

The gateway cannot answer permission approvals: T3's tools do not expose them. In a project with `runtimeMode` `approval-required` (the default), every command or edit the worker needs approved waits until you approve it in T3; the job shows `needs_input` with `waitingForApproval` meanwhile, and agents see that state and the project's mode in `fleet_status`. A project that should run unattended needs `runtimeMode` `auto` or `full-access` (and a host `access` at least that high). Choose looser modes per project deliberately: the worker runs in its own worktree, but with the mode's permissions on your machine.

#### Projects with a coordinator

If you run a long-lived T3 thread that coordinates a project (it plans, delegates to child threads of its own and reports back), register it as a standing job (`t3-fleet-gateway jobs adopt <alias> <threadId>`, see [operations.md](operations.md#standing-jobs)) and set `allowWorkStart: false` on the project. Agents then find the coordinator in `fleet_status` (`projects[].standingJobs`, with its job id, title, state and link), give it work with `work_continue`, and follow it with `work_feed` and `work_status`; an attempt to start a separate job there is refused with an error that names the coordinator. Leave `allowWorkStart` at `true` if agents may also start their own jobs alongside it. Changing the setting takes a restart of `serve`, like any config change.

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

| Field | Default | Meaning |
| --- | --- | --- |
| `pollSeconds` | `10` (2 to 300) | How often the job engine ticks: reconcile uncertain launches, poll active jobs' threads, dispatch queued jobs. Idle jobs are polled at most once a minute. A new job or agent action also triggers a tick at once. |
| `reconcileWindowMinutes` | `10` (1 to 240) | How long a launch with an unknown outcome may go unconfirmed, while the host answers, before the job fails with `launch_not_confirmed`. Time the host is unreachable does not count. |

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
