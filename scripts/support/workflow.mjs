import { customer, installFixture } from './fixture.mjs';

export async function escalate(scenario = 'happy path') {
  const state = installFixture(scenario);
  const { executeTool } = await import('../../lib/agent/executor.ts');
  const { POST } = await import('../../app/api/actions/[id]/route.ts');
  const run = (name, args) => executeTool(name, args, 'support-1');
  const query = scenario === 'unclear policy' ? 'expedited refund exceptions' : 'duplicate charge policy';
  const search = await run('searchKnowledgeBase', { query });
  const policy = search.result.data?.results?.find(row => row.confidence === 'confident');
  const lookup = await run('getCustomer', { query: customer.name });
  const contact = lookup.result.data?.customers?.[0];
  if (!contact) return { state, message: 'Customer lookup failed. Escalation paused.' };
  const followUp = await run('createTask', { customer_name: contact.name,
    title: policy ? 'Review duplicate charge' : 'Clarify billing policy',
    description: policy?.content ?? 'Ask a billing specialist to clarify the applicable policy.' });
  if (!followUp.result.success || !policy) return { state, message: 'Manual review required.' };
  const draft = await run('sendEmail', { to: contact.email, subject: 'Billing follow-up',
    body: 'Hi ' + contact.name + ',\n\n' + policy.content });
  if (draft.type !== 'pending') return { state, message: 'Could not queue draft.' };
  const resolve = action => POST(new Request('http://local.invalid', {
    method: 'POST', body: JSON.stringify({ action })
  }), { params: Promise.resolve({ id: draft.pendingActionId }) });
  return { state, draft: draft.args, resolve };
}
