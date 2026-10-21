import '../tlsTrust.ts';
import { SECOND } from '../time.ts';
import { API_HEADER } from './server.ts';

/**
 * Whether the public MCP URL (the tunnel agents use) serves the dashboard: it must not. The MCP listener has no dashboard
 * routes, so this fails only when the tunnel forwards to the dashboard's listener instead. Run by doctor and the
 * dashboard's checks, from this machine, through the real tunnel. Never throws.
 */
export type ExposureProbe =
  | { outcome: 'not_served' }
  | { outcome: 'served'; status: number }
  | { outcome: 'dashboard_listener'; status: number }
  | { outcome: 'unreachable' };

export async function probeDashboardExposure(publicUrl: string, basePath: string): Promise<ExposureProbe> {
  const base = basePath === '/' ? '' : basePath;
  try {
    const response = await fetch(`${publicUrl}${base}/api/snapshot`, { headers: { [API_HEADER]: '1' }, redirect: 'manual', signal: AbortSignal.timeout(5 * SECOND) });
    const type = response.headers.get('content-type') ?? '';
    await response.body?.cancel();
    if (response.status === 200) return { outcome: 'served', status: 200 };
    // The dashboard listener answers refusals (Funnel, unknown Host) in plain text; the MCP listener answers JSON.
    if ((response.status === 403 || response.status === 421) && type.startsWith('text/plain')) return { outcome: 'dashboard_listener', status: response.status };
    return { outcome: 'not_served' };
  } catch {
    return { outcome: 'unreachable' };
  }
}

export function describeExposure(probe: ExposureProbe): { level: 'ok' | 'warn' | 'fail'; code: string; detail: string } {
  switch (probe.outcome) {
    case 'not_served':
      return { level: 'ok', code: 'dashboard_not_public', detail: 'The public MCP URL does not serve the dashboard.' };
    case 'served':
      return { level: 'fail', code: 'dashboard_public', detail: 'The public MCP URL serves the dashboard. Point the tunnel at listen.port, never at dashboard.listen.port.' };
    case 'dashboard_listener':
      return { level: 'fail', code: 'dashboard_listener_public', detail: 'The public MCP URL reaches the dashboard listener (it refused the request). Point the tunnel at listen.port, never at dashboard.listen.port.' };
    case 'unreachable':
      return { level: 'warn', code: 'exposure_unverified', detail: 'Could not ask the public URL whether it serves the dashboard (it did not answer).' };
  }
}
