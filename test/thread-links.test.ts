import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeThreadScopes } from '../src/oauth/threadScopes.ts';
import { THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE } from '../src/oauth/scopes.ts';
import { FAKE_ENVIRONMENT_ID } from './helpers/fakeT3.ts';
import { assertNotLogged, startJob, startJobHarness } from './helpers/jobs.ts';

const v2 = (threadId: string) => `t3-thread://v2/${FAKE_ENVIRONMENT_ID}/${threadId}`;

for (const reconcile of [false, true]) {
  test(`v2 autolinks reach work_status through ${reconcile ? 'launch reconciliation from list' : 'launch and watcher reads'}`, async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    fake.threadLinkFormat = 'v2';
    if (reconcile) fake.failuresAfterEffect.set('t3_thread_launch', { code: 'internal_error', message: 'Synthetic lost launch answer.' });
    const job = await startJob(agent);
    await tick();
    const thread = fake.threadForJob(job.jobId);
    const expected = v2(thread.threadId);
    assert.equal((await agent.call('work_status', { jobId: job.jobId })).link, expected);
    assert.equal(fake.launches.length, 1);
    if (reconcile) assert.ok(fake.calls.includes('t3_thread_list'));
    else {
      // An old ledger row without a link learns it from a read, independently of the launch result.
      gw.services.jobs.store.transition(job.jobId, { from: ['running'], to: 'running', changes: { threadLink: null } });
      await tick();
      assert.equal((await agent.call('work_status', { jobId: job.jobId })).link, expected);
    }
    assertNotLogged(gw, [expected, thread.link]);
  });
}

test('v2 autolinks survive agent adoption, operator standing adoption, and fleet_status', async (t) => {
  const { fake, gw, agent } = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  fake.threadLinkFormat = 'v2';
  changeThreadScopes(gw.services.db, gw.clock, agent.clientId, 'grant', [THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE]);
  const external = () => fake.launchDirect({ projectId: 'project-1', title: 'Synthetic external thread', message: 'Synthetic task' }).threadId;
  const adoptedId = external();
  const adopted = await agent.call<{ job: { jobId: string; link: string } }>('work_adopt', {
    host: 'main', projectId: 'project-1', threadId: adoptedId, requestId: 'synthetic-adoption',
  });
  assert.equal(adopted.job.link, v2(adoptedId));
  assert.equal((await agent.call('work_status', { jobId: adopted.job.jobId })).link, v2(adoptedId));
  const standingId = external();
  const standing = await gw.services.jobs.adopt({ project: 'pilot', threadId: standingId });
  assert.equal(standing.job.threadLink, v2(standingId));
  assert.equal((await agent.call('work_status', { jobId: standing.job.id })).link, v2(standingId));
  const fleet = await agent.call<{ projects: { standingJobs: { link: string }[] }[] }>('fleet_status');
  assert.ok(fleet.projects.some((project) => project.standingJobs.some((job) => job.link === v2(standingId))));
  assertNotLogged(gw, [v2(adoptedId), v2(standingId)]);
});
