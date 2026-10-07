import pkg from '../package.json' with { type: 'json' };

export const GATEWAY_NAME = 't3-fleet-gateway';
export const GATEWAY_VERSION: string = pkg.version;
