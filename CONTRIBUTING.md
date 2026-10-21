# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

Node.js 24.22.1 or a later 24.x, or 26.12.1 or newer (`engines`; the launcher refuses older releases, see [docs/security.md](docs/security.md#compromised-emudhra-intermediates)). There is no build step: Node runs the TypeScript sources directly (type stripping).

```sh
npm install
npm run check   # tsc --noEmit, every test, then the privacy check
```

CI (`.github/workflows/check.yml`) runs the same `npm run check` on Node 24.22.1 and 26.12.1 on Linux and Node 26.12.1 on macOS for every push to `main` and every pull request. A pull request needs every CI check green to merge. Dependabot opens monthly grouped updates for npm packages and GitHub Actions; they go through CI like any other pull request. `.github/workflows/privacy.yml` re-checks a pull request's title, description and commit messages whenever they change.

## Ground rules

- **No secrets or machine-specific values**, anywhere: code, tests, fixtures, docs, commit messages. Use placeholders such as `example.ts.net`, `/path/to/repo`, and generated values in tests. Never paste real tokens, codes, hostnames, IPs, usernames or home-directory paths. The full list and the placeholders to use are in [AGENTS.md](AGENTS.md#privacy-and-publishing); `npm run privacy:check` enforces the common cases.
- **Logs never contain** tokens, approval or pairing codes, authorization headers, task text or message content. Log ids, states, codes and durations.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Import local files with their `.ts` extension; use `import type` for types.
- **Small modules with explicit types at boundaries.** Errors carry a stable code (`GatewayError` in `src/errors.ts`, `OAuthError` for OAuth responses); never rename a shipped code.
- **Migrations are append-only** (`src/db/migrations.ts`). Add a new version; never edit a shipped one.
- **Behavior changes update [docs/design.md](docs/design.md)** and the user-facing docs in the same pull request.

## Tests

Tests use `node:test` and live in `test/*.test.ts`. They never contact a real T3 server: `test/helpers/fakeT3.ts` is a fake built with the MCP SDK, with T3's pairing-code OAuth endpoints and failure injection. `test/helpers/gateway.ts` starts a full gateway on a loopback port with a controllable clock and captured logs. Tests never release a port and bind it again; see AGENTS.md.

Add a test for every bug fix and for every OAuth or authorization rule you touch.

## Privacy check

The repository is public, so `npm run privacy:check` (the last step of `npm run check`) scans every tracked file, and every new file git would add, for real-looking `*.ts.net` hosts, home-directory paths, private and tailnet IPs and credentials, and for the maintainer's own private list. It prints where a finding is and its category, never the text, so CI logs stay clean. In CI it also scans a pull request's title and description. Replace a finding with a placeholder; a rare synthetic fixture can carry `privacy-check: allow` on its line. To check PR or release text written to a file, run `npm run privacy:check -- --file notes.md` (`--stdin` and `--commits <range>` work too). To run it before every push, enable the optional hook with `git config core.hooksPath .githooks`.

The private list is for the maintainer: one entry per line, `#` for comments, a case-insensitive substring or `re:` and a JavaScript regular expression. Keep it in the gitignored `.privacy-denylist` (a linked worktree uses the main checkout's file; `PRIVACY_DENYLIST_FILE` names another) and never commit it. CI reads the same text from a repository secret:

```sh
gh secret set PRIVACY_DENYLIST --repo example-org/example-repo < .privacy-denylist
```

Pull requests from forks and from Dependabot do not receive repository secrets, so only the generic patterns run there; the summary line says how many private entries were loaded. The private list and `scripts/privacy-allow.json` are separate on purpose: nothing in the repository can allow a private entry.

## Commits

Small, logical commits with imperative subjects ("Add work_feed cursor paging"). Explain why in the body when it is not obvious.
