import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInternalAgent } from './internal-agent-hook.mjs';
const env = { CONCORDIA_HOST: '127.0.0.1', CONCORDIA_PORT: '11111' };
const input = { tool_name: 'Agent', tool_input: { prompt: 'README typo', subagent_type: 'fork', model: 'opus' } };
test('unrelated tool remains unchanged without contacting Cc', async () => {
  assert.deepEqual(await handleInternalAgent({tool_name:'Read'}, {}, () => { throw Error('unexpected'); }), {});
});
test('fork and explicit parent model are routed to the selected Cc provider', async () => {
  const result = await handleInternalAgent(input, env, async (_, options) => {
    assert.equal(JSON.parse(options.body).prompt, input.tool_input.prompt);
    return { ok:true, json:async()=>({selection:{call_name:'terra',provider:'codex',model:'gpt-5.6-terra',reasoning_effort:'low'}}) };
  });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /delegation_invoke/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /gpt-5.6-terra/);
});
test('failed selection never silently allows parent inheritance', async () => {
  for (const request of [async()=>{throw Error('offline')}, async()=>({ok:false}), async()=>({ok:true,json:async()=>({})})]) {
    assert.equal((await handleInternalAgent(input, env, request)).hookSpecificOutput.permissionDecision, 'deny');
  }
});
test('non-local endpoint and invalid input do not perform I/O', async () => {
  const request = () => { throw Error('unexpected I/O'); };
  assert.equal((await handleInternalAgent(input, {...env, CONCORDIA_HOST:'external.example'}, request)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await handleInternalAgent({tool_name:'Task',tool_input:{}},env,request)).hookSpecificOutput.permissionDecision,'deny');
});
