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
| `id` | required | Short stable id (lowercase letters, digits, hyphens; up to 32). Used in project config, CLI commands, tool output and per-host grants (`host:<id>:read`, `clients token --hosts <id>`): renaming a host drops it from every grant restricted to selected machines, and a grant for a removed id applies again to a new host given that id. |
| `label` | none | Human-friendly name shown in `fleet_status` and on the approval page, which anyone who registers a client can open. |
| `transportNote` | none | How the gateway reaches this host, in your words, up to 80 characters (for example `SSH tunnel` or `Same machine`). Shown on the operator dashboard next to `t3Url`; descriptive only, never checked. |
| `t3Url` | required | T3 server origin. `http` only for loopback; `https` for remote hosts. |
| `mintPairingCode` | `["t3","auth","pairing","create","--ttl","5m","--json"]` | Command (argv, no shell) that prints a T3 pairing code as JSON with a `credential` field. For a remote host use something like `["ssh","other-host","t3","auth","pairing","create","--ttl","5m","--json"]`. Adding `--label t3-fleet-gateway` makes the pairing easy to spot in T3. |
| `mintPairingCodeProbe` | none | Optional exact argv for a non-mutating check you have verified is safe to run at `doctor` and startup. No shell; 1–32 arguments, at most 4,096 characters each. Never set this to the pairing/mint command. See "Renewal command preflight" below. |
| `access` | `"auto"` | The T3 approval level the gateway requests when it enrolls: `read-only`, `approval-required`, `auto-accept-edits`, `auto` or `full-access`. T3 treats it as the ceiling for the runtime mode of threads the gateway starts, so a project's `runtimeMode` may not exceed it. Changing it takes a new `hosts enroll`. |
| `maxConcurrentJobs` | `2` (1 to 32) | Jobs holding a slot at once on this host: `dispatching`, `running`, `needs_input`, `cancel_requested` and `unknown` count; `idle` does not. Further jobs wait as `queued`, first in, first out. |
| `defaultModelSelection` | `null` | T3 `modelSelection` object (must contain `model`) for launches in projects on this host that set no `modelSelection` of their own, for example `{ "instanceId": "codex", "model": "<model id>" }`. T3's `orchestrator_capabilities` tool lists the provider instances and models, and so does `fleet_models` once discovery is enabled. |
| `defaultProject` | none | Configured scratch alias on this host for `work_start { target: { host } }`, when no project is named. Host-only starts also require discovery. See "No named project" below. |
| `discovery` | all off | Opt-in discovery of this host's T3 projects and model catalog for agents, and the policy for launching into T3 projects that have no `projects[]` entry. See "Discovery" below. |

Which `access` to choose: the host's `access` is only a ceiling. What a job may do without asking is decided per project by `runtimeMode`, which defaults to `approval-required`. [`config.example.json`](../config.example.json) therefore enrolls the host with `full-access`, so any project on it can be given a looser mode later without re-enrolling, and keeps its project at `approval-required`. Use a lower `access` if you want the host itself to rule out looser modes.

#### Discovery

Off by default. With `discovery` left out, agents see only the configured aliases and `work_start` takes only aliases without an explicit model selection. Existing worktree aliases keep their queueing behavior. Scratch aliases read a fresh project list to resolve their pinned ID even with discovery off.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Let agents list this host's T3 projects (`fleet_projects`: ids, names and how to start work in each) and its provider instances, models and model options (`fleet_models`), read live from T3 and kept for 30 seconds. Also required for `work_start` to accept a `target` or a `modelSelection` on this host. A `read-only` host can enable this for browsing. |
| `allowWorkStart` | `false` | Let `work_start` launch into a T3 project of this host that has no configured alias, by `target: { host, projectId }`. Needs `enabled`. Projects that do have an alias are always governed by that alias (below). |
| `runtimeMode` | `"approval-required"` | T3 runtime mode for launches into unconfigured projects. When `allowWorkStart` is true it must not exceed the host's `access`. |
| `baseRef` | `"main"` | Branch or ref such launches start their worktree from. |
| `branchPrefix` | `"fleet/"` | Branch prefix for such launches: `<branchPrefix><jobId>`. |

Discovery and launching are separate gates, and the per-agent grants still apply: an agent sees a host's catalogs only if it may read that host, and starts work there only with Operate on it. A host with `enabled: true` and `allowWorkStart: false` lets agents browse and choose a model for the configured aliases, but every launch still goes through an alias.

How a launch into a discovered project is governed:

- **A project exactly one alias maps to** (by `t3ProjectId`, or by a `t3ProjectTitle` only that project has) is launched as that alias, with every setting of the alias: `allowWorkStart` (so `false` still refuses with `start_disabled` and names the standing jobs), `workspaceMode`, `runtimeMode`, worktree settings and model defaults. Targeting by id never gets around a configured project. The job shows the alias as its project.
- **A project several aliases map to**, or one an alias's title mapping matches ambiguously, cannot be targeted by id: the agent must pass the alias it means.
- **A project no alias maps to** follows this host's discovery policy, and needs `allowWorkStart`. Its model is the host's `defaultModelSelection`, else the T3 project's own default model, else the agent must pass `modelSelection`; a launch with no model anywhere is refused before a job exists. The job's project is shown as the internal ref `@<host>/<projectId>`.

An agent's `modelSelection` (`{ instanceId, model, options? }`) is checked against the host's freshly read catalog when the job is created and again right before it is launched: provider instance and model must be advertised, every option id must be one the model advertises, a `select` option takes one of its choice ids and a `boolean` option a boolean. Anything else is refused and nothing is substituted or launched; a selection that disappears from the catalog while the job is queued fails the job with `model_selection_invalid` before any launch. Omitting it keeps the configured whole-object default (project, then host, then the T3 project default), with no merging across levels. What such a job resolved to is recorded with the job (`launch_spec`), so a later config or catalog change does not move it.

#### Renewal command preflight

`doctor` and `serve` check whether the first `mintPairingCode` argument resolves to an executable in the current process's `PATH` (or from its explicit path and working directory). They do not run that command. A missing or non-executable command is a failure; a selected path under `runtime/versions/<version>/` is a warning even if it still exists. A stable symlink is checked by the path selected through `PATH`, so its versioned target does not itself cause a pinned-path warning. Wrapper internals and the remote side of SSH remain unverified by resolution alone.

If you want a runtime check, configure `mintPairingCodeProbe` with a command whose exact behavior you know is non-mutating. For a local T3 entrypoint you have verified supports a harmless version flag, that can be `["t3", "--version"]`. For a custom wrapper or remote host, use your own read-only probe; the gateway executes only that configured argv and never appends guessed arguments to wrappers or SSH. Configuring a probe authorizes it at every `doctor` and startup. The gateway cannot prove an arbitrary command is non-mutating.

A probe has a ten-second deadline and a 4,096-byte limit on each output stream. The deadline is generous because the macOS service runs as a Background launchd agent, which schedules its children at a lower priority: a version probe that answers in about half a second in the foreground was measured taking over two seconds there (see [startup-probe evidence](evidence/startup-probe.md)). Exit success verifies the configured check. A bare version on stdout, the exact native T3 CLI form `t3 v<semver>` (for example `t3 v0.0.46-nightly.20261007.2774`), or JSON `{"version":"x.y.z"}` enables version comparison. The complete trimmed output must match one supported form; versions embedded in arbitrary output are not recognized. Doctor compares with fresh T3 health. Startup uses only already-completed, unexpired cached health and leaves comparison unverified when none is available; preflight never starts or waits for a health request. Different versions warn only. A nonzero exit, timeout or output overflow fails the probe check. No probe means `WARN probe_unverified`, not a known command failure. Command output, argv, executable paths and parsed probe versions are never printed or logged.

Use the same environment when running `doctor` that the service uses: an interactive shell's successful lookup does not verify a service's different `PATH`. Startup checks run in the background and all settle before automatic renewal starts; an unexpected check rejection logs `host.pairing_preflight_failed` but does not disable the renewal loop. Shutdown force-kills each probe's direct process without waiting, including one that ignores SIGTERM, and prevents renewal from starting afterward. A known mint resolution failure is checked again before each automatic renewal, records `pairing_command_failed` and skips pairing registration; probe warnings/failures are diagnostic and do not block renewal when the mint executable resolves.

### `projects`

What agents can target. Each entry:

| Field | Default | Meaning |
| --- | --- | --- |
| `alias` | required | The name agents use (lowercase letters, digits, `.`, `_`, `-`). |
| `description` | `""` | Shown to agents in `fleet_status`. |
| `host` | required | A host `id`. |
| `t3ProjectId` or `t3ProjectTitle` | exactly one required | The T3 project, by id or by exact title. `doctor` checks that it resolves. |
| `workspaceMode` | `"worktree"` | `worktree` creates a fresh Git worktree and branch. `scratch` launches in T3's internal scratch project and requires an explicit `t3ProjectId` pin. See "No named project" below. |
| `baseRef` | `"main"` | Branch or ref each worktree job starts from. Unused for scratch. |
| `branchPrefix` | `"fleet/"` | Worktree job branches are `<branchPrefix><jobId>`. Unused for scratch. |
| `runtimeMode` | `"approval-required"` | T3 runtime mode for job threads: `approval-required`, `auto-accept-edits`, `auto` or `full-access`. Must not exceed the host's `access`; projects cannot be placed on a `read-only` host. See "Approvals and unattended projects" below. |
| `modelSelection` | `null` | T3 `modelSelection` object (must contain `model`) for this project's launches. Without it the host's `defaultModelSelection` is used, and without that the T3 project's own default model. |
| `allowWorkStart` | `true` | Whether agents may start new jobs here with `work_start`. Set `false` for a project run by a standing coordinator thread: `work_start` then fails with `start_disabled`, naming the project's standing jobs, and agents send work to those with `work_continue`. See "Projects with a coordinator" below. |

#### No named project

To give a machine a projectless destination, identify its internal T3 scratch project, shown as "No project" in T3. Verify that identity in T3 before configuring it. The gateway cannot verify the project root from its sanitized catalog, and a matching title alone is not enough.

Merge these fields into your configuration, keeping the existing host URL and other settings. Replace the scratch project ID with the verified ID:

```json
{
  "hosts": [{
    "id": "machine-a",
    "t3Url": "http://127.0.0.1:3773",
    "defaultProject": "machine-a-scratch"
  }],
  "projects": [{
    "alias": "machine-a-scratch",
    "host": "machine-a",
    "workspaceMode": "scratch",
    "t3ProjectId": "<T3_SCRATCH_PROJECT_ID>"
  }]
}
```

Keep a configured model at the project, host, or T3 project level as described in "Models" below. Restart the gateway after changing the configuration. Then an agent can start projectless work with:

```json
{
  "target": { "host": "machine-a" },
  "task": "Investigate the requested issue and report the evidence.",
  "title": "Investigate the issue",
  "requestId": "<fresh-request-id>"
}
```

The agent interprets "no project" or an omitted project as this host-only target. The gateway resolves it to `defaultProject`; it does not parse the task text. A named project still uses its alias or `target: { host, projectId }`. Resolve an unknown project rather than falling back to scratch.

Host-only starts use the scratch alias's permissions and model defaults. They need neither `discovery.enabled` nor `discovery.allowWorkStart` (which governs unconfigured projects); only an explicit `projectId` and a model selection need discovery. A scratch job is recorded from the configuration without reading T3, so it queues while the host is down and records no T3 project name. The `t3ProjectId` pin must be the id of T3's internal scratch project: the gateway checks it against the host's projects before each launch and looks for a lost launch there, but a scratch launch itself sends no project id (T3 files the thread under its own scratch project). A scratch pin may not also be the pin of a worktree alias on the same host. Existing aliases default to worktrees. Scratch jobs have an empty `branch`, and T3 owns the scratch folders. Titles retain the `[job:<id>]` marker used for recovery.

Upgrading to a build with scratch support moves the ledger from schema version 10 (v0.1.9) to 11. Migration 11 changes no data and no table: it only makes older builds refuse the ledger, because they would read a scratch launch record as no record and start scratch work in a git worktree. Stop older gateway processes first, and back up the data directory before the first start of the new build: going back means restoring that backup. Running any command of the new build against the live data directory (`doctor`, `jobs list`, `pair`) migrates it, and a service still on the older build then refuses to start. Existing jobs, credentials, grants and webhook connections are preserved.

#### Models

T3 refuses to launch a thread without a model when the T3 project has no default model (`invalid_request`: "Pass modelSelection: the project has no default model"), and every job in that project then fails at once. Set `modelSelection` on the project or `defaultModelSelection` on its host, or give the project a default model in T3. `doctor` reports `FAIL` for a project that would have no model, `serve` logs `project.model_missing` at startup, and `fleet_status` shows agents `modelConfigured: false` for projects that rely on T3's default.

#### Approvals and unattended projects

The gateway cannot answer permission approvals: T3's tools do not expose them. In a project with `runtimeMode` `approval-required` (the default), every command or edit the worker needs approved waits until you approve it in T3; the job shows `needs_input` with `waitingForApproval` meanwhile, and agents see that state and the project's mode in `fleet_status`. A project that should run unattended needs `runtimeMode` `auto` or `full-access` (and a host `access` at least that high). Choose looser modes per project deliberately: the worker runs in the configured workspace, with the mode's permissions on your machine.

#### Projects with a coordinator

If you run a long-lived T3 thread that coordinates a project (it plans, delegates to child threads of its own and reports back), register it as a standing job (`t3-fleet-gateway jobs adopt <alias> <threadId>`, see [operations.md](operations.md#standing-jobs)) and set `allowWorkStart: false` on the project. Agents then find the coordinator in `fleet_status` (`projects[].standingJobs`, with its job id, title, state and link), give it work with `work_continue`, and follow it with `work_feed` and `work_status`; an attempt to start a separate job there is refused with an error that names the coordinator. Leave `allowWorkStart` at `true` if agents may also start their own jobs alongside it. Changing the setting takes a restart of `serve`, like any config change. Turning it off only refuses new `work_start` calls: jobs already queued in the project still launch when their host has a slot, and running ones carry on (cancel them with `work_cancel` if you do not want them).

### `tokens`

| Field | Default | Range |
| --- | --- | --- |
| `accessTtlSeconds` | `43200` (12 h) | 60 s to 7 days |
| `refreshIdleTtlDays` | `90` | 1 to 365. A refresh token not used for this long expires; each use rotates it and restarts the clock. |

OAuth TTLs govern gateway grants only; static bearer tokens from `clients token` use their own `--ttl` and have no refresh. Increasing these values cannot restore ingress or restart a disabled connector routine. Diagnose stored grants with `clients diagnose <client-id>` before changing TTLs; retain credentials and the saved feed cursor during outages. See [authentication and outage recovery](operations.md#authentication-and-outage-recovery).

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

### `dashboard`

The operator dashboard (v0.1.9): gateway, hosts, agent clients, jobs and recent job events in a browser, with manual **Run checks** and **Webhook connections**. Monitoring remains read-only; only webhook connection management changes state. Off by default. It runs inside `serve` on a listener of its own, never the MCP listener, so the tunnel that carries `/mcp` to agents does not carry it. See [operations.md](operations.md#operator-dashboard) for publishing it to your tailnet and [security.md](security.md#the-operator-dashboard) for the trust boundary.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Start the dashboard listener with `serve`. |
| `listen` | `{ "host": "127.0.0.1", "port": 3791 }` | Loopback only (`127.0.0.1`, `::1` or `localhost`), and a different port from `listen.port`. Publish it with a tailnet-only reverse proxy; never point a public tunnel (Funnel) at it. |
| `basePath` | `"/"` | The path it is served under: `/` or up to four lowercase segments such as `/t3-fleet-gateway`, with no trailing slash. Set it to the proxy's mount path, and have the proxy keep the path (for `tailscale serve --set-path /t3-fleet-gateway`, target `http://127.0.0.1:3791/t3-fleet-gateway`). |
| `allowedHosts` | `[]` | `Host` header values the dashboard accepts besides its own loopback address and port, exact and lowercase, with a port only when the browser shows one: your proxy's host name, such as `<machine>.<tailnet>.ts.net`. Anything else gets `421` (protection against DNS rebinding). At most 16. |
| `clientLabels` | `{}` | Display names for agent clients by client id (see `clients list`), for example a connector that registered as `Cursor` shown as `Grok Bot`. At most 100, each up to 80 characters. The registered name is still shown beside it. |

```json
"dashboard": {
  "enabled": true,
  "listen": { "host": "127.0.0.1", "port": 3791 },
  "basePath": "/t3-fleet-gateway",
  "allowedHosts": ["<machine>.<tailnet>.ts.net"],
  "clientLabels": { "<client id>": "Grok Bot" }
}
```

Changing dashboard listener settings takes a restart of `serve`. Connections created or changed in the Webhooks view take effect immediately. `doctor` checks that the dashboard answers on its listener and that the public URL does not serve it.

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

Then run `t3-fleet-gateway hosts enroll studio`. Adding a host is configuration plus enrollment. Agents approved for *All machines* (and every grant from before v0.1.5) can use it at once; agents approved for selected machines cannot until you approve them again with it ticked (see [operations.md](operations.md#connect-an-agent)).

## Webhooks

v0.1.9: `webhooks: { "subscriptions": [] }` is the default. The easiest setup is **Connect Grok Bot** in the private dashboard: paste a URL and full authentication header, choose a configured project and test the connection. It works with generic HTTPS receivers too. Dashboard connections live in the database, require no secret file or restart, and use the five default events with excerpts off. They survive config edits and restarts.

The file-managed alternative below remains supported. At most 32 saved active subscriptions across both sources are allowed; restart `serve` to apply file changes. The dashboard labels file-managed rows and cannot replace or disconnect them. ID collisions between ownership types are refused. The [manual setup example](setup.md#configure-a-webhook-by-hand) uses a Grok routine URL and sender-key header. No new incoming connection is required.

| Field | Meaning |
| --- | --- |
| `id` | Stable lowercase letters/digits/hyphens, 1–64 characters; unique in this config. Use in CLI commands. |
| `enabled` | Default `false`. Disabled entries enqueue/send nothing; an explicit test ping is still allowed. |
| `url` | Absolute HTTPS destination, up to 4,096 characters, no embedded credentials or fragment. Treat it as secret. No redirects are followed. |
| `auth.header` | Exact HTTP authentication header name supplied by the receiver, such as `X-Sender-Key` or `Authorization`. Transport/control headers (`Host`, framing, connection, proxy headers, etc.) are refused. |
| `auth.secretFile` | A regular file in the gateway data directory, named by a single filename, owned by the current user and readable only by that user (`0600`), never a symlink or FIFO. Contents are the header value, up to 8 KiB; one final newline is removed. Empty/missing/invalid secrets fail closed. |
| `projects`, `hosts` | Optional nonempty lists; OR within each, AND between them. Omitted means all. Project matching uses the stored alias (or discovery's `@host/projectId` ref). |
| `events` | Nonempty selection of `needs_input`, `idle`, `failed`, `cancelled`, `delegated_work_ended`, `running`. Defaults to the first five. |
| `excerptChars` | Default `0` omits both excerpt fields. Opt in with 1–500 for a bounded worker excerpt and truncation flag. Worker secrets cannot be reliably redacted. |
| `allowLoopbackHttp` | Default `false`. Isolated development only: permits HTTP at literal `127.0.0.1` or `[::1]`; no other HTTP host. HTTPS always validates certificates. |

Use `webhooks ping <id>` to test config without creating a job, then restart the gateway to apply file changes. The CLI also supports persisted dashboard connections; `webhooks list` identifies the management source. A 2xx test result means the receiver accepted the request; check the bot conversation for its result. `webhooks list` and `webhooks attempts <id> --limit 20` are offline diagnostics and do not apply their config over the serving process. Secrets are stored as plaintext inside the existing protected data directory/database, like downstream credentials. Keep config private too because URLs can contain credentials in their path/query. Protect backups.

New subscriptions do not replay history. Disabling/removing a subscription, or changing its route, key, filters or excerpt policy, cancels its old queue. Unchanged routes resume after restart. An already transmitted request can still arrive. Payloads are capped at 16 KiB; oversized upstream metadata increments the same explicit overflow diagnostic as a full queue. [Delivery, overflow, retention and feed catch-up](design.md#outbound-job-webhooks) define recovery; retain polling even when notifications work.
