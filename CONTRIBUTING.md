# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

Node.js 24 or newer. There is no build step: Node runs the TypeScript sources directly (type stripping).

```sh
npm install
npm run check   # tsc --noEmit, then every test
```

CI (`.github/workflows/check.yml`) runs the same `npm run check` on Node 24 and 26 on Linux and Node 26 on macOS for every push to `main` and every pull request. A pull request needs every CI check green to merge. Dependabot opens monthly grouped updates for npm packages and GitHub Actions; they go through CI like any other pull request.

## Ground rules

- **No secrets or machine-specific values**, anywhere: code, tests, fixtures, docs, commit messages. Use placeholders such as `example.ts.net`, `/path/to/repo`, and generated values in tests. Never paste real tokens, codes, hostnames, IPs, usernames or home-directory paths.
- **Logs never contain** tokens, approval or pairing codes, authorization headers, task text or message content. Log ids, states, codes and durations.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Import local files with their `.ts` extension; use `import type` for types.
- **Small modules with explicit types at boundaries.** Errors carry a stable code (`GatewayError` in `src/errors.ts`, `OAuthError` for OAuth responses); never rename a shipped code.
- **Migrations are append-only** (`src/db/migrations.ts`). Add a new version; never edit a shipped one.
- **Behavior changes update [docs/design.md](docs/design.md)** and the user-facing docs in the same pull request.

## Tests

Tests use `node:test` and live in `test/*.test.ts`. They never contact a real T3 server: `test/helpers/fakeT3.ts` is a fake built with the MCP SDK, with T3's pairing-code OAuth endpoints and failure injection. `test/helpers/gateway.ts` starts a full gateway on a loopback port with a controllable clock and captured logs. Tests never release a port and bind it again; see AGENTS.md.

Add a test for every bug fix and for every OAuth or authorization rule you touch.

## Commits

Small, logical commits with imperative subjects ("Add work_feed cursor paging"). Explain why in the body when it is not obvious.
