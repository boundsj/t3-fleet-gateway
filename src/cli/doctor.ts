import { mcpResource, type GatewayConfig } from '../config.ts';
import { checkDataDirPermissions } from '../dataDir.ts';
import { SCHEMA_VERSION, schemaVersion } from '../db/database.ts';
import { describeError } from '../errors.ts';
import type { GatewayServices } from '../gateway.ts';
import { checkProjectModel, resolveProject } from '../hosts/projects.ts';
import { describeExposure, probeDashboardExposure } from '../dashboard/exposure.ts';
import { probePublicUrl, RESOURCE_NAME, resourceMetadataUrl } from '../oauth/metadata.ts';
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
  const probe = await probePublicUrl(config.publicUrl, mcpResource(config));
  switch (probe.outcome) {
    case 'ok':
      return { level: 'ok', name, detail: `${config.publicUrl} serves this gateway's metadata` };
    case 'http_error':
      return { level: 'fail', name, detail: `${url} answered HTTP ${probe.status}` };
    case 'wrong_resource':
      return { level: 'fail', name, detail: `${url} names resource ${probe.resource}, expected ${mcpResource(config)}` };
    case 'different_server':
      return { level: 'fail', name, detail: `${url} serves a different server's metadata (resource_name ${probe.resourceName}, expected ${RESOURCE_NAME})` };
    case 'unreachable':
      return { level: 'fail', name, detail: `${url} is not reachable (${probe.errorName}). Is the gateway running and the tunnel up?` };
  }
}

/** The dashboard answers on its own loopback listener, and the public MCP URL does not serve it. */
async function checkDashboard(config: GatewayConfig): Promise<CheckResult[]> {
  const { host, port } = config.dashboard.listen;
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const path = config.dashboard.basePath === '/' ? '/' : `${config.dashboard.basePath}/`;
  let local: CheckResult;
  try {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5 * SECOND) });
    await response.body?.cancel();
    local = response.status === 200
      ? { level: 'ok', name: 'dashboard', detail: `${origin}${path} answers (loopback only; publish it with a tailnet-only proxy)` }
      : { level: 'fail', name: 'dashboard', detail: `${origin}${path} answered HTTP ${response.status}` };
  } catch {
    local = { level: 'warn', name: 'dashboard', detail: `${origin}${path} is not answering. Is serve running?` };
  }
  const exposure = describeExposure(await probeDashboardExposure(config.publicUrl, config.dashboard.basePath));
  return [local, { level: exposure.level, name: 'dashboard exposure', detail: exposure.detail }];
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

  for (const connection of services.webhooks.health()) {
    const h = connection.health;
    results.push({ level: h.failureStreak || h.deadLettered || h.overflowCount ? 'warn' : 'ok', name: `webhook ${connection.id}`,
      detail: `last success ${h.lastSuccessAt ?? 'unknown'}; last failure ${h.lastFailureAt ?? 'unknown'}; ` +
        `failure streak ${h.failureStreak}; pending ${h.pending}; dead-lettered ${h.deadLettered}; omitted ${h.overflowCount}` });
  }
  const reachable = new Set<string>();
  for (const host of config.hosts) {
    const name = `host ${host.id}`;
    // Even a host with no credential needs a usable command for its first enrollment.
    const credential = registry.credentialStatus(host.id);
    for (const alert of registry.credentialAlerts(host.id)) {
      results.push({ level: alert.resolvedAt === null ? 'warn' : 'ok', name: `${name} credential alert`,
        detail: `${alert.kind}: ${alert.resolvedAt === null ? 'active; re-pair from the private dashboard or hosts enroll' : 'resolved'}` });
    }
    if (credential.state === 'missing') {
      for (const check of await registry.preflight(host.id)) {
        results.push({ level: check.level, name: `${name} pairing command`, detail: check.detail });
      }
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
    for (const check of await registry.preflight(host.id, { serverVersion: health.t3Version })) {
      results.push({ level: check.level, name: `${name} pairing command`, detail: check.detail });
    }
    if (health.credentialRejected) {
      results.push({ level: 'fail', name, detail: `T3 at ${host.t3Url} rejected the stored credential. Run: t3-fleet-gateway hosts enroll ${host.id}` });
    } else if (health.reachable === true) {
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
      const t3Project = await resolveProject(registry, project);
      results.push({ level: 'ok', name, detail: `T3 project ${t3Project.id} on ${project.host}` });
      const model = checkProjectModel(config, project, t3Project);
      results.push({ level: model.ok ? 'ok' : 'fail', name, detail: model.detail });
    } catch (error) {
      results.push({ level: 'fail', name, detail: describeError(error).message });
    }
  }

  results.push(await checkPublicUrl(config));
  if (config.dashboard.enabled) results.push(...(await checkDashboard(config)));
  return results;
}
