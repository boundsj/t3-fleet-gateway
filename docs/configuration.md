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
| `t3Url` | required | T3 server origin. `http` only for loopback; `https` for remote hosts. |
| `mintPairingCode` | `["t3","auth","pairing","create","--ttl","5m","--json"]` | Command (argv, no shell) that prints a T3 pairing code as JSON with a `credential` field. For a remote host use something like `["ssh","other-host","t3","auth","pairing","create","--ttl","5m","--json"]`. Adding `--label t3-fleet-gateway` makes the pairing easy to spot in T3. |
| `mintPairingCodeProbe` | none | Optional exact argv for a non-mutating check you have verified is safe to run at `doctor` and startup. No shell; 1–32 arguments, at most 4,096 characters each. Never set this to the pairing/mint command. See "Renewal command preflight" below. |
| `workspaceProbeCommand` | none | Fixed argv for destination workspace inspection before named launches. Paths are sent through stdin JSON only. See "Workspace inspection" below. |
| `access` | `"auto"` | The T3 approval level the gateway requests when it enrolls: `read-only`, `approval-required`, `auto-accept-edits`, `auto` or `full-access`. T3 treats it as the ceiling for the runtime mode of threads the gateway starts, so a project's `runtimeMode` may not exceed it. Changing it takes a new `hosts enroll`. |
| `maxConcurrentJobs` | `2` (1 to 32) | Jobs holding a slot at once on this host: `dispatching`, `running`, `needs_input`, `cancel_requested` and `unknown` count; `idle` does not. Further jobs wait as `queued`, first in, first out. |
| `defaultModelSelection` | `null` | T3 `modelSelection` object (must contain `model`) for launches in projects on this host that set no `modelSelection` of their own, for example `{ "instanceId": "codex", "model": "<model id>" }`. T3's `orchestrator_capabilities` tool lists the provider instances and models, and so does `fleet_models` once discovery is enabled. |
| `discovery` | all off | Opt-in discovery of this host's T3 projects and model catalog for agents, and the policy for launching into T3 projects that have no `projects[]` entry. See "Discovery" below. |

Which `access` to choose: the host's `access` is only a ceiling. What a job may do without asking is decided per project by `runtimeMode`, which defaults to `approval-required`. [`config.example.json`](../config.example.json) therefore enrolls the host with `full-access`, so any project on it can be given a looser mode later without re-enrolling, and keeps its project at `approval-required`. Use a lower `access` if you want the host itself to rule out looser modes.

#### Discovery

Off by default. With `discovery` left out, agents see only configured aliases and `work_start` takes only aliases. New named launches still read the destination project root for workspace inspection; browsing and model catalog access remain disabled.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Let agents list this host's T3 projects (`fleet_projects`: ids, names and how to start work in each) and its provider instances, models and model options (`fleet_models`), read live from T3 and kept for 30 seconds. Also required for `work_start` to accept a `target` or a `modelSelection` on this host. A `read-only` host can enable this for browsing. |
| `allowWorkStart` | `false` | Let `work_start` launch into a T3 project of this host that has no configured alias, by `target: { host, projectId }`. Needs `enabled`. Projects that do have an alias are always governed by that alias (below). |
| `runtimeMode` | `"approval-required"` | T3 runtime mode for launches into unconfigured projects. When `allowWorkStart` is true it must not exceed the host's `access`. |
| `baseRef` | `"main"` | Legacy queued launches use this branch or ref. New automatic launches always use updated `origin/main`; an explicit `workspace` override selects another base. |
| `branchPrefix` | `"fleet/"` | Branch prefix for such launches: `<branchPrefix><jobId>`. |

Discovery and launching are separate gates, and the per-agent grants still apply: an agent sees a host's catalogs only if it may read that host, and starts work there only with Operate on it. A host with `enabled: true` and `allowWorkStart: false` lets agents browse and choose a model for the configured aliases, but every launch still goes through an alias.

How a launch into a discovered project is governed:

- **A project exactly one alias maps to** (by `t3ProjectId`, or by a `t3ProjectTitle` only that project has) is launched as that alias, with every setting of the alias: `allowWorkStart` (so `false` still refuses with `start_disabled` and names the standing jobs), `runtimeMode`, `branchPrefix` and the model defaults; legacy launches also retain `baseRef`. Targeting by id never gets around a configured project. The job shows the alias as its project.
- **A project several aliases map to**, or one an alias's title mapping matches ambiguously, cannot be targeted by id: the agent must pass the alias it means.
- **A project no alias maps to** follows this host's discovery policy, and needs `allowWorkStart`. Its model is the host's `defaultModelSelection`, else the T3 project's own default model, else the agent must pass `modelSelection`; a launch with no model anywhere is refused before a job exists. The job's project is shown as the internal ref `@<host>/<projectId>`.

An agent's `modelSelection` (`{ instanceId, model, options? }`) is checked against the host's freshly read catalog when the job is created and again right before it is launched: provider instance and model must be advertised, every option id must be one the model advertises, a `select` option takes one of its choice ids and a `boolean` option a boolean. Anything else is refused and nothing is substituted or launched; a selection that disappears from the catalog while the job is queued fails the job with `model_selection_invalid` before any launch. Omitting it keeps the configured whole-object default (project, then host, then the T3 project default), with no merging across levels. What such a job resolved to is recorded with the job (`launch_spec`), so a later config or catalog change does not move it.

#### Workspace inspection

Configure `workspaceProbeCommand` on each host used for named project launches. It is an operator-owned fixed argv, run without a shell. Install `scripts/workspace-probe.js` and Node on the destination. For a local host use `["/opt/tools/node", "/opt/fleet/workspace-probe.js"]`. A remote example uses only fixed SSH arguments:

```json
"workspaceProbeCommand": ["ssh", "-T", "-o", "BatchMode=yes", "build-host", "/opt/tools/node", "/opt/fleet/workspace-probe.js"]
```

The gateway never adds paths or caller text to argv. It writes stdin JSON with `root`, `baseRef`, `startFromOrigin` and `requireGit`. The helper returns JSON with `kind` (`git` or `root`), canonical `root` and filesystem `identity`. Output is limited to 16 KiB and the command has a 15-second deadline. Only a canonical project root equal to Git's top level is treated as a Git project. An ordinary subdirectory inside another repository uses its own local directory; corrupt intervening `.git` metadata fails inspection. Inherited Git context variables are removed without changing credential configuration.

Omitting `work_start.workspace` detects the project automatically. A Git project gets a fresh T3-managed wt from freshly fetched `origin/main`. Other directories use the local checkout. `{ "type": "root" }` explicitly uses the current local checkout, preserving its branch and dirty files. `{ "type": "worktree", "baseRef": "topic", "startFromOrigin": false }` explicitly uses a local base. Explicit wt selection defaults to `main` and `startFromOrigin: true`. Missing origin or remote branch fails closed for remote-based wt launches. Scratch aliases reject workspace overrides.

The destination is inspected again before dispatch. Changed identity or classification fails with `launch_policy_changed`. Verification failures fail closed. SSH exit 255 and probe deadlines report `workspace_probe_unavailable` only on the affected job. Queued jobs retry the probe at the watcher interval for at most three attempts per daemon lifetime, then fail. Retry counters reset after a daemon restart; the last error remains persisted. Probe backoff does not block other queued jobs or mark the T3 host unreachable. Actual T3 transport failures retain host backoff. No command output or paths enter errors or logs.

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
| `baseRef` | `"main"` | Legacy queued launches use this branch or ref. New automatic launches always use updated `origin/main`; an explicit `workspace` override selects another base. |
| `branchPrefix` | `"fleet/"` | Job branches are `<branchPrefix><jobId>`. |
| `runtimeMode` | `"approval-required"` | T3 runtime mode for job threads: `approval-required`, `auto-accept-edits`, `auto` or `full-access`. Must not exceed the host's `access`; projects cannot be placed on a `read-only` host. See "Approvals and unattended projects" below. |
| `modelSelection` | `null` | T3 `modelSelection` object (must contain `model`) for this project's launches. Without it the host's `defaultModelSelection` is used, and without that the T3 project's own default model. |
| `allowWorkStart` | `true` | Whether agents may start new jobs here with `work_start`. Set `false` for a project run by a standing coordinator thread: `work_start` then fails with `start_disabled`, naming the project's standing jobs, and agents send work to those with `work_continue`. See "Projects with a coordinator" below. |

#### Models

T3 refuses to launch a thread without a model when the T3 project has no default model (`invalid_request`: "Pass modelSelection: the project has no default model"), and every job in that project then fails at once. Set `modelSelection` on the project or `defaultModelSelection` on its host, or give the project a default model in T3. `doctor` reports `FAIL` for a project that would have no model, `serve` logs `project.model_missing` at startup, and `fleet_status` shows agents `modelConfigured: false` for projects that rely on T3's default.

#### Approvals and unattended projects

The gateway cannot answer permission approvals: T3's tools do not expose them. In a project with `runtimeMode` `approval-required` (the default), every command or edit the worker needs approved waits until you approve it in T3; the job shows `needs_input` with `waitingForApproval` meanwhile, and agents see that state and the project's mode in `fleet_status`. A project that should run unattended needs `runtimeMode` `auto` or `full-access` (and a host `access` at least that high). Choose looser modes per project deliberately: the worker runs in its own worktree, but with the mode's permissions on your machine.

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
