# t3-fleet-gateway

Let long-running AI agents in the cloud hand coding work to the [T3 Code](https://github.com/pingdotgg/t3code) servers on your own machines, and follow that work to completion.

The agent says *what* to do in *which project*. The gateway decides *where* and *how*: which machine, which T3 project, a fresh git worktree per job, the T3 thread, and watching it. You never have to pick worktrees or threads, or keep checking threads by hand. Every job is an ordinary T3 thread you can open, read and interrupt.

The first supported agent is Grok Bot; any MCP client with OAuth support should work.

## Status

**v0.1, in development.** What works today:

- The agent-facing MCP server (Streamable HTTP) with its own OAuth 2.1 authorization server: dynamic client registration, an approval page gated by one-time codes, PKCE, rotating refresh tokens.
- Downstream connections to one or more T3 Code servers, with credentials the gateway obtains and renews itself through T3's pairing-code approval.
- The job layer: `work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list` and `work_feed`, with a durable job ledger, a dispatcher that respects each host's concurrency limit, a watcher that follows every job's T3 thread, and reconciliation for launches whose outcome was lost.
- Standing jobs: a T3 thread you already work in (a long-running coordinator, say) that you register for agents to drive with the same tools.
- The `fleet_status` tool, the operator CLI, and deploy templates for launchd and systemd.

The automated suite uses a fake T3 built from T3's published tool schemas; [`scripts/e2e-live.ts`](scripts/e2e-live.ts) is the live check against a real T3 server (see [docs/operations.md](docs/operations.md#live-end-to-end-check)). A live run has confirmed starting a job in its own worktree and branch, following it to idle with the worker's reply, continuing it, the job links, and cancelling a running job (T3 interrupts the thread and the job becomes `cancelled`); the handling of questions, approvals and failed runs is not yet confirmed live. Known limits: permission approvals can only be given in T3 itself (T3's tools do not expose them), so jobs in projects with `runtimeMode` `approval-required` (the default) wait for you to approve in T3, and projects that should run unattended need `auto` or `full-access` (see [docs/configuration.md](docs/configuration.md#approvals-and-unattended-projects)); sign-in from browser-based MCP clients is not supported (no CORS on the OAuth endpoints, see [docs/security.md](docs/security.md#known-limitations)). See [docs/design.md](docs/design.md).

## How it works

```
Agent (Grok Bot, any MCP client)
   │  HTTPS through your tunnel, OAuth 2.1 (tokens issued by this gateway)
   ▼
t3-fleet-gateway  ── SQLite (clients, tokens, host credentials, jobs)
   │  MCP client per host, bearer credential issued by that host's T3
   ▼
T3 Code server(s)
```

- One process on an always-on machine, listening on loopback. You expose it with a tunnel you already run (Tailscale Funnel, Cloudflare Tunnel, and so on).
- Agents connect to `https://<your public URL>/mcp`. On first connect the agent opens an approval page; you type a one-time code that you mint on the gateway machine and choose **Read** or **Operate**.
- The gateway holds its own credential for each T3 server and renews it before it expires (T3 credentials last 30 days). Agent tokens never reach T3, and T3 credentials never leave the gateway.

## Quickstart

Requirements: Node.js 24 or newer (the latest Node 24 or 26 release is recommended), a T3 Code server, and the `t3` CLI on the machine that can mint pairing codes for it.

```sh
git clone https://github.com/<you>/t3-fleet-gateway.git
cd t3-fleet-gateway
npm install

mkdir -p ~/.config/t3-fleet-gateway
cp config.example.json ~/.config/t3-fleet-gateway/config.json
# Edit publicUrl, hosts and projects. See docs/configuration.md.

node bin/t3-fleet-gateway.js hosts enroll main   # obtain a T3 credential for host "main"
node bin/t3-fleet-gateway.js serve                # or install the launchd/systemd service
node bin/t3-fleet-gateway.js doctor               # check everything, including the public URL
```

Point your tunnel at the gateway's listen address (default `127.0.0.1:3790`) so that `publicUrl` reaches it over HTTPS.

The package runs its TypeScript sources directly with Node's type stripping, so run it from a checkout (or `npm link` it). It is not published to npm.

## Connect Grok Bot

1. Make sure `t3-fleet-gateway doctor` passes, including the `public URL` check.
2. In Grok Bot, add a remote MCP server with the URL `https://<your public URL>/mcp`.
3. Grok Bot registers itself and opens the gateway's approval page. On the gateway machine run:

   ```sh
   node bin/t3-fleet-gateway.js pair
   ```

   Enter the printed code on the page, choose **Read** (follow work) or **Operate** (start and steer work), and approve.
4. Ask Grok Bot to call `fleet_status`. It should list your hosts and project aliases.
5. Ask it to start a small task with `work_start` in one of those projects, then to check `work_feed` on a schedule. Each job is a T3 thread titled with `[job:<id>]` in a fresh worktree on its own branch, so you can open it in T3 at any time.

`t3-fleet-gateway clients list` shows connected agents; `clients revoke <id>` disconnects one. If approvals or registrations are throttled (someone probing your URL), `pair` lifts an approval pause and `throttle reset` clears both limits; see [docs/operations.md](docs/operations.md#throttles).

## Standing jobs: give an agent your coordinator thread

By default an agent starts a new T3 thread for each piece of work. If you already run a long-lived thread that coordinates a project (a "chief of staff" that plans, delegates to child threads and reports back), you can let the agent talk to that thread instead:

```sh
node bin/t3-fleet-gateway.js jobs adopt pilot <thread id> --title "Chief of Staff"
```

The gateway checks that the thread belongs to project `pilot` and records it as a **standing job**. The agent sees it with `standing: true` in `work_list`, `work_feed` and `work_status`, sends it instructions with `work_continue`, and follows its turns with `work_feed` and `work_status`, just as for jobs it started. A standing job takes no concurrency slot, `work_cancel` only interrupts its current turn (it stays open), and the agent can never close it. `jobs release <job id>` stops the gateway from following it without touching the thread. Details: [docs/operations.md](docs/operations.md#standing-jobs).

## Security model, in short

- Agents authenticate with tokens this gateway issues; approval needs a one-time code minted on the gateway machine. Codes and tokens are stored only as hashes.
- The gateway obtains T3 credentials by automating T3's pairing-code consent with your own machine access (the same access `t3 auth pairing create` needs). Choose the T3 access level per host.
- Everything listens on loopback; the tunnel is the only way in. Logs never contain tokens, codes, authorization headers, task text or message content.

Details: [docs/security.md](docs/security.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Documentation

- [docs/configuration.md](docs/configuration.md): every config field
- [docs/operations.md](docs/operations.md): enroll, pair, revoke, renewal, standing jobs, doctor, running as a service, logs, backup, uninstall
- [docs/security.md](docs/security.md): threat model and what is stored where
- [docs/design.md](docs/design.md): the design specification

## Development

```sh
npm install
npm run check      # typecheck and the full test suite
npm test           # tests only (node:test)
npm run typecheck  # tsc --noEmit
```

Tests use a fake T3 server built with the MCP SDK and never touch a real T3. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
