import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConsultationHook } from './consultation-harness.mjs';

test('consultation hook cannot proceed without Cc and its own session', async () => {
  await assert.rejects(checkConsultationHook({ prompt: 'hi' }, {}));
  await assert.rejects(checkConsultationHook({ tool_name: 'WebSearch', tool_input: { query: 'x' } },
    { LICTOR_PORT: '1', CONCORDIA_URL: 'http://127.0.0.1:2' }, async () => { throw Error('offline'); }));
});
test('forwards tool arguments and honors a deny verdict', async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    if (!options.body) return Response.json({ session_id: 'own' });
    request = JSON.parse(options.body); return Response.json({ blocked: true });
  };
  await assert.rejects(checkConsultationHook({ tool_name: 'WebSearch', tool_input: { query: 'x' } },
    { LICTOR_PORT: '1', CONCORDIA_URL: 'http://127.0.0.1:2' }, fetchImpl));
  assert.deepEqual(request, { session_id: 'own', phase: 'tool', text: '{"query":"x"}', tool: 'WebSearch' });
});
