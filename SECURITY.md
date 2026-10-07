# Security policy

## Reporting a vulnerability

Please report security problems privately, not in public issues. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's Security tab). Include what you found, how to reproduce it, and the impact you expect. You should get an acknowledgement within a week.

Please do not include real tokens, approval codes, pairing codes, hostnames or other secrets in reports; synthetic values are enough.

## Supported versions

Only the latest release on the default branch receives fixes while the project is pre-1.0.

## Threat model

The threat model, what the gateway stores and where, and how it automates T3's pairing-code consent are in [docs/security.md](docs/security.md). In short:

- Agents get tokens only after the operator approves with a one-time code minted on the gateway machine. Tokens and codes are stored as hashes, refresh tokens rotate with replay detection, and tokens are bound to this gateway's MCP resource.
- T3 credentials are held by the gateway only, stored in a private data directory, and never sent to agents or written to logs.
- The gateway listens on loopback and is exposed only through the operator's tunnel.
