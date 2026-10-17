/**
 * The operator dashboard on a synthetic fleet, for development, browser checks and screenshots. Not part of `npm test`.
 * Starts a real gateway with its own temporary data directory and fake T3 hosts on loopback, seeds fictional clients
 * (Grok Bot, Muse, Notion) and jobs through the gateway's public paths, and serves the dashboard until Ctrl-C. It never
 * reads your config or data directory and never contacts a real T3 or connector. See docs/operations.md, "Dashboard demo".
 *
 *   node scripts/dashboard-demo.ts [--scenario mixed|healthy|host-down|auth-issue|empty] [--port 4791] [--base-path /]
 *                                  [--no-badge] [--list]
 */
import { parseArgs } from 'node:util';
import { demoLogger, SCENARIO_NOTES, SCENARIOS, startDemoFleet, type Scenario } from './lib/demo-fleet.ts';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'mixed' },
    port: { type: 'string', default: '4791' },
    'base-path': { type: 'string', default: '/' },
    'no-badge': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
  strict: true,
});

if (values.list) {
  for (const scenario of SCENARIOS) process.stdout.write(`${scenario.padEnd(11)} ${SCENARIO_NOTES[scenario]}\n`);
  process.exit(0);
}
if (!SCENARIOS.includes(values.scenario as Scenario)) {
  process.stderr.write(`Unknown scenario ${values.scenario}; use one of: ${SCENARIOS.join(', ')}\n`);
  process.exit(2);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('--port must be a port number (0 picks a free one)\n');
  process.exit(2);
}

const scenario = values.scenario as Scenario;
process.stdout.write(`Seeding the "${scenario}" fleet: ${SCENARIO_NOTES[scenario]}\n`);
const fleet = await startDemoFleet({
  scenario,
  dashboardPort: port,
  basePath: values['base-path'],
  badge: values['no-badge'] ? null : 'Synthetic demo',
  logger: demoLogger(),
  runEngine: true,
});
process.stdout.write(`\nDashboard: ${fleet.dashboardUrl}\n(loopback only; synthetic data; Ctrl-C stops it and deletes the temporary data directory)\n`);

const stop = async () => {
  process.stdout.write('\nStopping…\n');
  await fleet.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
