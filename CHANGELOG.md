# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## Unreleased (0.1.0)

### Added

- Agent-facing MCP server on `/mcp` (Streamable HTTP, stateless, JSON responses) that serves both 2025-era and 2026-07-28 clients and accepts requests without `MCP-Protocol-Version`.
- OAuth 2.1 authorization server: metadata, dynamic registration for public clients, an approval page gated by one-time codes minted with `pair` (Read or Operate), PKCE S256, rotating refresh tokens with replay detection and a retry grace window, idle expiry, and per-client revocation.
- Downstream T3 Code client per host, with enrollment through T3's pairing-code approval, verified credential storage, and automatic renewal before the 30-day expiry.
- `fleet_status` tool.
- CLI: `serve`, `pair`, `clients list|revoke`, `hosts enroll|status`, `doctor`.
- SQLite storage with versioned migrations, including the tables for the job layer.
- launchd installer and systemd user unit.

### Planned

- Job tools (`work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list`, `work_feed`), dispatcher, watcher and reconciliation.
