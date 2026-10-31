# t3-fleet-gateway

T3 Fleet Gateway lets outside bots and agents start and follow coding work on your [T3 Code](https://github.com/pingdotgg/t3code) machines through one authenticated HTTP MCP connection. It tracks each job in a persistent ledger and can notify your bot when work needs attention.

## T3 Code alone or with the gateway?

**T3 Code already supports multiple machines and outside agents.** In v0.1.4 and v0.1.5, you can connect several environments to one T3 app. Its **Linked environments** beta lets agents on one machine launch, message, wait on and stop work on another, answer questions, and delegate across machines. Enable the beta on both machines and approve a peer link. [Remote access and linked environments (v0.1.5)](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/remote-access.md#link-another-environment).

T3 also has its own authenticated HTTP MCP server for outside agents and bots that support OAuth. Its built-in tools include `t3_environment_links`, `t3_project_list`, `t3_thread_launch` and `t3_thread_send`; tools that support `environmentId` can act on a linked machine. You do not need this gateway just to give a bot MCP access or control several machines. [Outside-agent setup](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/outside-agents.md) · [Peer routing](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/internals/remote.md#peer-links).

**The gateway adds an operator-managed job and notification layer:**

| Need | What the gateway provides |
| --- | --- |
| One connection for outside bots | One HTTP MCP endpoint, with OAuth or operator-issued bearer tokens and Read/Operate access to all or selected hosts. |
| Wake the right bot | Webhooks filtered by project, host, job, original client and event; bot-owned job subscriptions, delivery health and bounded event replay. |
| Retry without starting duplicate jobs | Persistent `requestId` deduplication, downstream launch retry keys when T3 advertises them, and reconciliation of uncertain launches. T3 itself also supports launch keys; the gateway keeps the job record around them. |
| Keep host access working | Automatic downstream credential renewal, failure/expiry alerts through matching configured webhooks, and confirmed **Re-pair** in the private dashboard. |
| Set launch rules and diagnose trouble | Project aliases with model, workspace and runtime rules; `doctor`; and a private dashboard for hosts, clients, jobs and webhook connections. |

**How often do you approve again?** Upstream v0.1.5 documents 30-day peer links, renewed by linking again with a fresh pairing code, and outside-agent sign-ins that require approval again after 30 days. T3 Connect's device access renews automatically; it is a separate connection mechanism. The gateway renews its own downstream T3 credentials before expiry using your configured pairing command. A bot's gateway OAuth grant can refresh while its refresh token remains usable; expiry or revocation requires approval again. Gateway bearer tokens have no refresh flow. Neither option can restart a disabled bot routine. [Upstream sign-in lifetime](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/outside-agents.md#remove-an-agent) · [Gateway recovery](docs/operations.md#authentication-and-outage-recovery).

- **Choose T3 alone** if its app, linked environments and native MCP tools cover your work and you are comfortable with their access lifecycle.
- **Choose the gateway** if outside bots need durable job IDs, precise wake-ups, project launch rules or centralized credential upkeep and diagnostics.
- **Use both** to work directly in T3 while bots follow and steer gateway jobs. Each job is an ordinary T3 thread you can open yourself.

This comparison uses stable [T3 v0.1.5](https://github.com/pingdotgg/t3code/releases/tag/v0.1.5), commit `6d450a428485`, and the [v0.1.4 changelog](https://github.com/pingdotgg/t3code/releases/tag/v0.1.4), which records linked-environment and launch-key support. It does not assume unreleased upstream behavior.

## Quick start

You need:

- An always-on machine with **Node.js 24.22.1 or a later 24.x, or 26.12.1 or newer**. Older releases lack the required [TLS protection](docs/security.md#compromised-emudhra-intermediates).
- A running T3 Code server and a `t3` CLI that can create pairing codes for it.
- An HTTPS address reachable by your bot, forwarding to the gateway's MCP listener. Keep the optional dashboard on a separate private route.

The gateway runs from a Git checkout; it is not published to npm. For a background service, use a dedicated checkout so development edits cannot change what the service runs. [Full setup guide](docs/setup.md).

### 1. Install and configure

```sh
git clone https://github.com/boundsj/t3-fleet-gateway.git
cd t3-fleet-gateway
npm ci --omit=dev
mkdir -p ~/.config/t3-fleet-gateway
cp config.example.json ~/.config/t3-fleet-gateway/config.json
chmod 600 ~/.config/t3-fleet-gateway/config.json
```

Edit the private config before starting:

- Set `publicUrl` to your gateway's public HTTPS origin, such as `https://gateway.example.com`.
- Set each host's `t3Url` and `mintPairingCode` command. The example host ID is `main`.
- Point the example `pilot` project alias at a real T3 project using `t3ProjectId` or its exact `t3ProjectTitle`.
- Replace the example model ID, or remove `defaultModelSelection` if the T3 project already has a default model.

Keep discovery off and `runtimeMode: "approval-required"` for your first job. [Configuration reference](docs/configuration.md).

### 2. Pair a host and start the gateway

From the checkout, enroll each configured host by ID:

```sh
node bin/t3-fleet-gateway.js hosts enroll main
node bin/t3-fleet-gateway.js serve
```

Enrollment verifies the T3 credential before saving it. Leave `serve` running and point your HTTPS tunnel at the MCP listener (default `127.0.0.1:3790`). In another terminal, from the same checkout:

```sh
node bin/t3-fleet-gateway.js doctor
```

Resolve failures before connecting a bot. Doctor checks the public URL from this machine and checks T3 separately; your bot still needs to verify its own route. For automatic startup, follow [Run as a service](docs/operations.md#run-as-a-service).

### 3. Connect a bot

Add `https://gateway.example.com/mcp` to your bot's remote MCP settings, replacing the example origin with yours. For an OAuth client, create a one-time approval code:

```sh
node bin/t3-fleet-gateway.js pair
```

Enter it on the gateway's approval page. Choose **Read** to follow work or **Operate** to start and steer it. **All machines** includes hosts added later; **Selected machines** stays limited to your selection. Codes expire after 15 minutes by default.

For a client that only accepts a bearer token, the gateway supports `clients token`. Follow [bearer-client setup](docs/operations.md#agents-that-only-take-a-bearer-token) and enter the token privately in the connector. Never paste tokens or pairing codes into chat.

### 4. Try a small job

Tell your bot:

```text
Call fleet_status and show me the machines and project aliases I can use.
In project pilot, check the README for broken local links and propose the
smallest fix. Use work_start with a new requestId, keep the job ID and T3
link, and read the result with work_status and work_messages.
Run the relevant checks. Don't merge or deploy anything.
```

By default, a named-project job gets a fresh worktree and branch. Open its link to watch or participate in T3. The bot can answer worker questions; permission approvals still need your action in T3. An `idle` job means its turn stopped, not necessarily that the task succeeded. If `waitingOnDelegatedWork` is true, its helpers are still working.

## Core concepts

| Term | Meaning |
| --- | --- |
| Host | A T3 Code server on one machine. The gateway connects to each configured host independently. |
| Project alias | A short name, such as `pilot`, mapped to a host and T3 project, with launch rules you choose. |
| Client | A bot or agent connected to the gateway, with its own access grant. |
| Job | The gateway's record of work: a stable ID, T3 thread link, state and event history that survive gateway restarts. |
| Worker | The agent running inside the T3 thread. Your outside bot gives it work and reads its replies. |
| Webhook | An HTTP notification that wakes a bot or receiver. The bot uses MCP to read the job's current details. |

Give each new operation a unique `requestId`. If the response is lost, retry with the **same ID and identical input**. Keep the job ID and the `work_feed` cursor; do not start a second job just because a connection failed. [Recovery rules](docs/operations.md#authentication-and-outage-recovery).

### Tools your bot uses

| Task | MCP tools |
| --- | --- |
| See hosts, projects and models | `fleet_status`, `fleet_projects`, `fleet_models` |
| Start work | `work_start` |
| Read state, history and replies | `work_status`, `work_list`, `work_feed`, `work_messages` |
| Follow up, answer questions or interrupt | `work_continue`, `work_respond`, `work_cancel` |
| Settle a quiet thread after review | `work_settle` |
| Find and adopt existing T3 threads, with extra access | `fleet_threads`, `work_adopt` |
| Inspect assigned notification connections, subscribe and recover events | `work_notifications`, `work_subscribe`, `work_replay` |

Read/Operate grants apply per host. Discovery and external-thread access need additional opt-ins. Tool schemas and limits live in [the design reference](docs/design.md#tools).

## Get updates when work changes

Polling `work_feed` works without webhooks. Add a webhook when you want the bot to wake promptly for a finished turn, a question, a failure or other selected events.

For Grok Bot, create a webhook-triggered routine first. Ask it for private links to its **Webhook URL** and **Authorization header** fields without printing their values. In the private gateway dashboard, open **Connect Grok Bot**, paste **POST to** into **Webhook URL** and the full **header** into **Full authorization header**, choose a project, then click **Connect & Test**. The full header includes the key.

Test acceptance means the receiver accepted the HTTP request; check the bot conversation to confirm that its routine ran. Have the routine deduplicate by `eventId`, read `work_status`/`work_messages`, and keep `work_feed` catch-up enabled. Delivery can be duplicated or arrive out of order. Excerpts are off by default.

Use the dashboard to replace connection details, send a test or disconnect. Recreating a routine can change both its URL and key. Other HTTPS receivers are supported too. For per-bot job subscriptions, an operator provisions an owned connection before the bot uses `work_subscribe`.

- [Dashboard setup and webhook walkthrough](docs/setup.md#add-the-private-dashboard)
- [Precise filters, delivery health and replay](docs/operations.md#precise-bot-notifications-and-recovery)
- [Webhook configuration](docs/configuration.md#webhooks)
- [Credential alerts and confirmed re-pair](docs/operations.md#credential-renewal)

## Monitor and finish work

![The private dashboard showing fictional hosts, clients and jobs.](docs/images/dashboard.png)

*The real dashboard with a synthetic demo fleet.*

The private dashboard shows hosts, clients, jobs needing attention, credential problems and webhook delivery health. **Run checks** refreshes diagnostics. It also manages webhook connections, confirms host re-pair and settles quiet jobs. Keep it behind a private network proxy: anyone who can reach it can use those controls. [Dashboard access and setup](docs/operations.md#operator-dashboard).

Job views include cached PR links and states when workers register them with T3's `link_pull_request`. These snapshots can lag GitHub; see [PR tracking limits](docs/design.md#job-pull-request-snapshots).

After review, `work_settle` parks a quiet thread without archiving it or changing the job state. It requires Operate access and checks for running, queued and delegated work. An idle settled job can be continued later. [Settlement behavior](docs/design.md#thread-settlement).

## Configuration: choose what to enable

Start with [config.example.json](config.example.json). The default location is `~/.config/t3-fleet-gateway/config.json`; keep it and the data directory private. Configuration changes take effect at startup. Dashboard-managed connections and client scope edits have their own live update flows.

| Option | Use it for |
| --- | --- |
| [Projects, models and runtime modes](docs/configuration.md#projects) | Alias destinations, model defaults, launch permissions and whether workers ask for approvals. |
| [Discovery](docs/configuration.md#discovery) | Let agents browse T3 projects and models. Launching into projects without aliases is a separate opt-in; aliases keep their rules. `fleet_models` supports search on newer hosts. |
| [Scratch default](docs/configuration.md#no-named-project) | Work that names a machine but no project. Requires an explicitly pinned scratch alias; unknown named projects never fall back to scratch. |
| [Workspace selection](docs/configuration.md#workspace-probe) | Opt into work in the project's own folder or a worktree. Root work edits the existing folder directly; reservations cover gateway-managed jobs only. |
| [Standing jobs](docs/operations.md#standing-jobs) | Register a coordinator thread you already use, then keep talking to it through the same job ID. |
| [External thread access](docs/design.md#external-thread-discovery-and-adoption) | Let selected clients discover/adopt existing T3 threads using `threads:read` and `threads:control`, in addition to host access. |
| [Attachments](docs/attachments.md) | Send base64 images and files with `work_start` or `work_continue`; file URLs are unsupported. |
| [Renewal](docs/configuration.md#renewal) | Credential renewal timing and alert thresholds. |

### Standing instructions for workers

Use the optional top-level `standingInstructions` to give every newly launched worker shared rules. This is a partial config snippet:

```json
{
  "standingInstructions": "Run the relevant checks and describe the result before handing work back."
}
```

The text is added to the first message at dispatch, including scratch and discovered-project jobs. It is not added to follow-ups or existing adopted threads. These are prompt instructions, not enforced restrictions. [Limits and lifecycle](docs/configuration.md#standinginstructions).

## Guides and troubleshooting

| I want to… | Read this |
| --- | --- |
| Install manually, run as a service or connect a client | [Setup](docs/setup.md) |
| Look up every configuration field | [Configuration](docs/configuration.md) |
| Diagnose connections, recover access, update or back up | [Operations](docs/operations.md) |
| Understand credentials, access and trust boundaries | [Security](docs/security.md) |
| Read tool contracts and implementation details | [Design](docs/design.md) |
| See release changes | [Changelog](CHANGELOG.md) · [GitHub releases](https://github.com/boundsj/t3-fleet-gateway/releases) |

Start connection troubleshooting with `doctor`, then `clients diagnose <client-id>` for the bot's stored authorization state. A valid grant does not prove that a hosted bot saved its token or that its routine is enabled. [Authentication and outage recovery](docs/operations.md#authentication-and-outage-recovery).

Server-side and native MCP clients are supported. Browser-only clients cannot complete gateway OAuth sign-in because its OAuth endpoints do not provide CORS. [Known limitations](docs/security.md#known-limitations). Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run check             # typecheck, tests with fake T3, and privacy checks
npm run dashboard:demo    # dashboard with a synthetic fleet
npm run webhooks:smoke    # isolated HTTPS, retry and crash checks; needs OpenSSL
```

The [compatibility check](docs/operations.md#developer-compatibility-check) is a separate, manual read-only probe against T3. It is not part of the test suite. Start contributing with [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
