import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { GatewayError } from './errors.ts';

/** Approval levels T3 accepts for an MCP client. Anything above read-only is also the runtime-mode ceiling. */
export const T3_ACCESS_LEVELS = ['read-only', 'approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export type T3Access = (typeof T3_ACCESS_LEVELS)[number];

export const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

const DEFAULT_MINT_COMMAND = ['t3', 'auth', 'pairing', 'create', '--ttl', '5m', '--json'];

const slug = (max: number) =>
  z
    .string()
    .regex(new RegExp(`^[a-z0-9][a-z0-9-]{0,${max - 1}}$`), 'use lowercase letters, digits and hyphens');

/** An origin-only URL: http is allowed only for loopback hosts. */
const originUrl = (what: string) =>
  z.string().transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: `${what} must be an absolute URL` });
      return z.NEVER;
    }
    const secureEnough = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
    if (!secureEnough) {
      ctx.addIssue({ code: 'custom', message: `${what} must use https (http is allowed only for loopback hosts)` });
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      ctx.addIssue({ code: 'custom', message: `${what} must be an origin with no path, query, fragment or credentials` });
    }
    return url.origin;
  });

/** A T3 `modelSelection` object, passed through as T3 expects it, for example `{ instanceId, model }`. */
const modelSelectionSchema = z.looseObject({ model: z.unknown() });

const hostSchema = z.strictObject({
  id: slug(32),
  label: z.string().min(1).max(80).optional(),
  t3Url: originUrl('t3Url'),
  mintPairingCode: z.array(z.string().min(1)).min(1).default(DEFAULT_MINT_COMMAND),
  access: z.enum(T3_ACCESS_LEVELS).default('auto'),
  maxConcurrentJobs: z.int().min(1).max(32).default(2),
  defaultModelSelection: modelSelectionSchema.nullable().default(null),
});

const projectSchema = z
  .strictObject({
    alias: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'use lowercase letters, digits, dots, underscores and hyphens'),
    description: z.string().max(500).default(''),
    host: z.string(),
    t3ProjectId: z.string().min(1).optional(),
    t3ProjectTitle: z.string().min(1).optional(),
    baseRef: z.string().min(1).max(200).default('main'),
    branchPrefix: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9._/-]*$/, 'use letters, digits, dots, underscores, hyphens and slashes')
      .default('fleet/'),
    runtimeMode: z.enum(RUNTIME_MODES).default('approval-required'),
    modelSelection: modelSelectionSchema.nullable().default(null),
    /** false: agents cannot start new jobs here, only drive the project's standing jobs with work_continue. */
    allowWorkStart: z.boolean().default(true),
  })
  .refine((project) => (project.t3ProjectId === undefined) !== (project.t3ProjectTitle === undefined), {
    message: 'set exactly one of t3ProjectId or t3ProjectTitle',
  });

const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    publicUrl: originUrl('publicUrl'),
    listen: z
      .strictObject({
        host: z.string().refine((host) => ['127.0.0.1', '::1', 'localhost'].includes(host), {
          message: 'listen.host must be a loopback address; expose the gateway through a tunnel',
        }),
        port: z.int().min(1).max(65535),
      })
      .default({ host: '127.0.0.1', port: 3790 }),
    allowedOrigins: z.array(originUrl('allowedOrigins entry')).default([]),
    hosts: z.array(hostSchema).min(1, 'configure at least one host'),
    projects: z.array(projectSchema).default([]),
    tokens: z
      .strictObject({
        accessTtlSeconds: z.int().min(60).max(7 * 86400).default(43200),
        refreshIdleTtlDays: z.int().min(1).max(365).default(90),
      })
      .default({ accessTtlSeconds: 43200, refreshIdleTtlDays: 90 }),
    renewal: z
      .strictObject({
        renewWhenDaysLeft: z.int().min(1).max(29).default(5),
        checkEveryMinutes: z.int().min(1).max(1440).default(60),
      })
      .default({ renewWhenDaysLeft: 5, checkEveryMinutes: 60 }),
    watcher: z
      .strictObject({
        pollSeconds: z.int().min(2).max(300).default(10),
        reconcileWindowMinutes: z.int().min(1).max(240).default(10),
      })
      .default({ pollSeconds: 10, reconcileWindowMinutes: 10 }),
  })
  .superRefine((config, ctx) => {
    const hostIds = new Set<string>();
    config.hosts.forEach((host, index) => {
      if (hostIds.has(host.id)) ctx.addIssue({ code: 'custom', path: ['hosts', index, 'id'], message: `duplicate host id "${host.id}"` });
      hostIds.add(host.id);
    });
    const aliases = new Set<string>();
    config.projects.forEach((project, index) => {
      if (aliases.has(project.alias)) {
        ctx.addIssue({ code: 'custom', path: ['projects', index, 'alias'], message: `duplicate project alias "${project.alias}"` });
      }
      aliases.add(project.alias);
      const host = config.hosts.find((candidate) => candidate.id === project.host);
      if (!host) {
        ctx.addIssue({ code: 'custom', path: ['projects', index, 'host'], message: `unknown host "${project.host}"` });
        return;
      }
      if (!runtimeModeAllowed(project.runtimeMode, host.access)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', index, 'runtimeMode'],
          message: `runtimeMode "${project.runtimeMode}" exceeds host "${host.id}" access "${host.access}"`,
        });
      }
    });
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type HostConfig = GatewayConfig['hosts'][number];
export type ProjectConfig = GatewayConfig['projects'][number];

/** Where a project's launches get their model in the gateway config, or null to leave it to the T3 project's default. */
export function configuredModel(config: GatewayConfig, project: ProjectConfig): { source: 'project' | 'host'; selection: Record<string, unknown> } | null {
  if (project.modelSelection) return { source: 'project', selection: project.modelSelection };
  const host = config.hosts.find((candidate) => candidate.id === project.host);
  return host?.defaultModelSelection ? { source: 'host', selection: host.defaultModelSelection } : null;
}

/** T3 caps a client's runtime modes at its approval level; read-only clients cannot launch work. */
export function runtimeModeAllowed(mode: RuntimeMode, access: T3Access): boolean {
  if (access === 'read-only') return false;
  return RUNTIME_MODES.indexOf(mode) <= RUNTIME_MODES.indexOf(access);
}

export function parseConfig(input: unknown): GatewayConfig {
  const result = configSchema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const path = issue.path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join('');
    return `  ${path.replace(/^\./, '') || '(root)'}: ${issue.message}`;
  });
  throw new GatewayError('config_invalid', `Invalid configuration:\n${problems.join('\n')}`);
}

export function loadConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GatewayError('config_not_found', `No config file at ${path}. Copy config.example.json there and edit it.`);
    }
    throw new GatewayError('config_invalid', `Cannot read config file ${path}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new GatewayError('config_invalid', `Config file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(json);
}

export interface Paths {
  configPath: string;
  dataDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv, overrides: Partial<Paths> = {}): Paths {
  return {
    configPath: overrides.configPath ?? env.T3FG_CONFIG ?? join(homedir(), '.config', 't3-fleet-gateway', 'config.json'),
    dataDir: overrides.dataDir ?? env.T3FG_DATA_DIR ?? join(homedir(), '.local', 'share', 't3-fleet-gateway'),
  };
}

/** The canonical resource identifier agents' tokens are bound to. */
export function mcpResource(config: GatewayConfig): string {
  return `${config.publicUrl}/mcp`;
}
