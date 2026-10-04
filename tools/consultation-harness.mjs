/** Claude consultation hook: block on an unavailable Cc check; never log input. */
export async function checkConsultationHook(input, env = process.env, fetchImpl = fetch) {
  if (!env.LICTOR_PORT || !env.CONCORDIA_URL) throw new Error('consultation_harness_unconfigured');
  const response = await fetchImpl(`http://127.0.0.1:${env.LICTOR_PORT}/v1/concordia/session`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('consultation_session_unavailable');
  const session = await response.json();
  const id = session.session_id ?? session.session?.id ?? session.id;
  if (typeof id !== 'string' || !id) throw new Error('consultation_session_unavailable');
  const tool = input.tool_name;
  const text = tool ? JSON.stringify(input.tool_input ?? {}) : input.prompt;
  if (typeof text !== 'string' || text.length > 50000) throw new Error('consultation_input_invalid');
  const result = await fetchImpl(`${env.CONCORDIA_URL.replace(/\/$/, '')}/v1/consultation-safety/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(35000),
    body: JSON.stringify({ session_id: id, phase: tool ? 'tool' : 'prompt', text, ...(tool ? { tool } : {}) }),
  });
  if (!result.ok) throw new Error('consultation_guard_unavailable');
  const verdict = await result.json();
  if (verdict.blocked !== false) throw new Error('consultation_policy_blocked');
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 100000) throw new Error('input_too_large'); }
    await checkConsultationHook(JSON.parse(raw));
  } catch {
    process.stderr.write('Cc の相談ハーネスがこの操作をブロックしました。管理者が監査記録を確認できます。\n');
    process.exitCode = 2;
  }
}
