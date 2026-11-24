import assert from 'node:assert/strict';
import test from 'node:test';
import { escalate } from './workflow.mjs';
import { customer, policy } from './fixture.mjs';

for (const scenario of ['happy path', 'unclear policy', 'lookup failure', 'approval rejection',
  'approved retry', 'concurrent approval', 'send failure', 'queue failure']) {
  test(scenario, async () => {
    const { state, resolve, draft } = await escalate(scenario);
    const calls = state.trace.filter(row => row.step === 'tool_call');
    assert.deepEqual(calls.slice(0, 2).map(row => row.tool_name), ['searchKnowledgeBase', 'getCustomer']);
    assert.equal(state.attempts, 0);
    if (scenario === 'lookup failure') {
      assert.equal(calls[1].status, 'error');
      assert.equal(state.tasks.length, 0);
    } else {
      assert.equal(state.tasks.length, 1);
      assert.equal(state.tasks[0].related_customer_id, customer.id);
    }
    if (['unclear policy', 'lookup failure', 'queue failure'].includes(scenario)) {
      assert.equal(resolve, undefined);
      assert.equal(state.drafts.length, 0);
      if (scenario === 'unclear policy') assert.match(state.tasks[0].title, /Clarify/);
      if (scenario === 'queue failure') assert.equal(calls.at(-1).status, 'error');
      return;
    }
    assert.equal(draft.to, customer.email);
    assert.ok(draft.body.includes(policy.content));
    const reject = scenario === 'approval rejection';
    const failed = scenario === 'send failure';
    const first = resolve(reject ? 'reject' : 'approve');
    const concurrent = scenario === 'concurrent approval' ? resolve('approve') : null;
    assert.equal((await first).status, 200);
    if (concurrent) assert.equal((await concurrent).status, 409);
    if (scenario === 'approved retry' || reject) assert.equal((await resolve('approve')).status, 409);
    assert.equal(state.attempts, reject ? 0 : 1);
    assert.equal(state.outbox.length, reject || failed ? 0 : 1);
    if (state.outbox.length) assert.equal(state.outbox[0].text, draft.body);
    const events = state.trace.filter(row => row.output?.event);
    assert.deepEqual(events.map(row => row.output.event), reject
      ? ['drafted', 'rejected'] : ['drafted', 'approved', failed ? 'failed' : 'sent']);
    assert.equal(events.at(-1).status, failed || reject ? 'error' : 'success');
    assert.ok(state.trace.every(row => row.trace_id === 'support-1'));
  });
}
