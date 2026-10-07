import { mcpResource, type GatewayConfig } from '../config.ts';
import { checkDataDirPermissions } from '../dataDir.ts';
import { SCHEMA_VERSION, schemaVersion } from '../db/database.ts';
import { describeError } from '../errors.ts';
import type { GatewayServices } from '../gateway.ts';
import { resolveProjectId } from '../hosts/projects.ts';
import { resourceMetadataUrl } from '../oauth/metadata.ts';
import { SECOND } from '../time.ts';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  level: CheckLevel;
  name: string;
  detail: string;
}

async function checkPublicUrl(config: GatewayConfig): Promise<CheckResult> {
  const url = resourceMetadataUrl(config.publicUrl);
  const name = 'public URL';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5 * SECOND) });
    if (!response.ok) return { level: 'fail', name, detail: `${url} answered HTTP ${response.status}` };
    const body = (await response.json()) as { resource?: unknown };
    if (body.resource !== mcpResource(config)) {
      return { level: 'fail', name, detail: `${url} names resource ${String(body.resource)}, expected ${mcpResource(config)}` };
    }
    return { level: 'ok', name, detail: `${config.publicUrl} serves this gateway's metadata` };
  } catch (error) {
    return { level: 'fail', name, detail: `${url} is not reachable (${(error as Error).name}). Is the gateway running and the tunnel up?` };
  }
}

/** Run every check; never throws. The caller already loaded the config and opened the services. */
export async function runDoctor(services: GatewayServices, dataDir: string): Promise<CheckResult[]> {
  const { config, db, registry } = services;
  const results: CheckResult[] = [{ level: 'ok', name: 'config', detail: `${config.hosts.length} host(s), ${config.projects.length} project(s)` }];
  try {
    checkDataDirPermissions(dataDir);
    results.push({ level: 'ok', name: 'data directory', detail: `${dataDir} is private` });
  } catch (error) {
    results.push({ level: 'fail', name: 'data directory', detail: describeError(error).message });
  }
  const integrity = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
  const version = schemaVersion(db);
  results.push(
    integrity === 'ok' && version === SCHEMA_VERSION
      ? { level: 'ok', name: 'database', detail: `integrity ok, schema version ${version}` }
      : { level: 'fail', name: 'database', detail: `integrity ${integrity}, schema version ${version} (expected ${SCHEMA_VERSION})` },
  );

  const reachable = new Set<string>();
  for (const host of config.hosts) {
    const name = `host ${host.id}`;
    const credential = registry.credentialStatus(host.id);
    if (credential.state === 'missing') {
      results.push({ level: 'fail', name, detail: `not enrolled. Run: t3-fleet-gateway hosts enroll ${host.id}` });
      continue;
    }
    if (credential.state === 'expired') results.push({ level: 'fail', name, detail: `credential expired. Run: t3-fleet-gateway hosts enroll ${host.id}` });
    else if (credential.state === 'renewal_due') results.push({ level: 'warn', name, detail: `credential expires in ${credential.daysLeft} day(s); renewal is due` });
    else results.push({ level: 'ok', name, detail: `credential valid for ${credential.daysLeft} more day(s)` });
    if (credential.renewalError) {
      results.push({ level: 'warn', name, detail: `last renewal failed: ${credential.renewalError.code}: ${credential.renewalError.message}` });
    }
    const health = await registry.health(host.id, { fresh: true });
    if (health.reachable === true) {
      reachable.add(host.id);
      results.push({ level: 'ok', name, detail: `T3 ${health.t3Version} reachable at ${host.t3Url}` });
    } else {
      results.push({ level: 'fail', name, detail: `${health.error?.code}: ${health.error?.message}` });
    }
  }

  for (const project of config.projects) {
    const name = `project ${project.alias}`;
    if (!reachable.has(project.host)) {
      results.push({ level: 'warn', name, detail: `skipped: host ${project.host} is not reachable` });
      continue;
    }
    try {
      const id = await resolveProjectId(registry, project);
      results.push({ level: 'ok', name, detail: `T3 project ${id} on ${project.host}` });
    } catch (error) {
      results.push({ level: 'fail', name, detail: describeError(error).message });
    }
  }

  results.push(await checkPublicUrl(config));
  return results;
}
