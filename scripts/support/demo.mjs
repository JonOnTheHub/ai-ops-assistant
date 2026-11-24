import { createInterface } from 'node:readline/promises';
import { escalate } from './workflow.mjs';

const flow = await escalate();
console.log('Internal follow-up', flow.state.tasks);
if (flow.draft) {
  console.log('Email awaiting approval', flow.draft);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question('Type approve to send to the fake outbox, or reject: ');
    console.log(await (await flow.resolve(answer.trim() === 'approve' ? 'approve' : 'reject')).json());
  } finally { terminal.close(); }
} else console.log(flow.message);
console.log(JSON.stringify({ trace: flow.state.trace, outbox: flow.state.outbox }, null, 2));
