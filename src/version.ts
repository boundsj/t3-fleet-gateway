import pkg from '../package.json' with { type: 'json' };

export const GATEWAY_NAME = 't3-fleet-gateway';
/** Release version shared by CLI and MCP; package.json is the single source of truth. */
export const GATEWAY_VERSION: string = pkg.version;
