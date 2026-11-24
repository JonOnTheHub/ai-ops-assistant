// Process-local service boundary. Unknown requests fail closed.
export const customer = { id: 'customer-1', name: 'Rae Vale', email: 'rae@example.invalid' };
export const policy = { id: 'policy-1', source: 'billing-review.md',
  content: 'Support must open a billing review for duplicate charges. A specialist will follow up.' };

export function installFixture(scenario) {
  Object.assign(process.env, { SUPABASE_URL: 'http://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'demo',
    RESEND_API_KEY: 're_demo', EMAIL_SANDBOX_MODE: 'false', RESEND_FROM_EMAIL: 'demo@example.invalid',
    VOYAGE_API_KEY: 'demo', GROQ_API_KEY: 'demo' });
  const state = { tasks: [], drafts: [], trace: [], outbox: [], attempts: 0 };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const table = url.pathname.split('/').pop();
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : null;
    const reply = (data, status = 200) => Response.json(data, { status });
    if (url.hostname === 'api.voyageai.com') return reply({ data: [{ embedding: [1] }] });
    if (url.hostname === 'api.resend.com' && table === 'emails') {
      state.attempts++;
      if (scenario === 'send failure') return reply({ name: 'validation_error', message: 'Fake rejection' }, 422);
      state.outbox.push(body);
      return reply({ id: 'message-1' });
    }
    if (url.hostname !== 'db.invalid') throw Error('Unexpected host: ' + url.hostname);
    switch (table) {
      case 'match_kb_documents_ids': return reply([{ id: policy.id, similarity: scenario === 'unclear policy' ? 0.15 : 0.9 }]);
      case 'match_kb_documents_fulltext_ids': return reply([{ id: policy.id, rank: 1 }]);
      case 'kb_documents': return reply([policy]);
      case 'employees': return reply([]);
      case 'customers':
        if (scenario === 'lookup failure') return reply({ message: 'CRM unavailable' }, 400);
        if (url.searchParams.get('name') === 'ilike.%' + customer.name + '%') return reply(customer);
        if (url.searchParams.get('email') === 'ilike.' + customer.email) return reply([customer]);
        return reply(url.searchParams.get('or')?.includes('name.ilike.%' + customer.name + '%') ? [customer] : []);
      case 'tasks': {
        const task = { ...body, id: 'task-1' };
        state.tasks.push(task);
        return reply(task);
      }
      case 'trace_logs': state.trace.push(body); return reply(null);
      case 'pending_actions':
        if (request.method === 'POST') {
          if (scenario === 'queue failure') return reply({ message: 'Queue unavailable' }, 400);
          const draft = { ...body, id: 'draft-1' };
          state.drafts.push(draft);
          return reply(draft);
        }
        if (request.method === 'PATCH') {
          const draft = state.drafts.find(row => ['id', 'status'].every(key =>
            url.searchParams.get(key) === 'eq.' + row[key]));
          return reply(draft ? [Object.assign(draft, body)] : []);
        }
    }
    throw Error('Unexpected fixture request: ' + request.method + ' ' + url);
  };
  return state;
}
