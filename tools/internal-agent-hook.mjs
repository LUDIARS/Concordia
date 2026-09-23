/** @implements spec/feature/internal-agent-model-policy.md */
import { pathToFileURL } from 'node:url';
const deny = (reason) => ({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
} });
export async function handleInternalAgent(input, env, request = fetch) {
  if (!['Agent', 'Task'].includes(input?.tool_name)) return {};
  const task = input.tool_input;
  if (!task || typeof task.prompt !== 'string' || !task.prompt.trim()) {
    return deny('Cc: 子タスク本文が必要です。内部Agentは未起動です。');
  }
  const host = env.CONCORDIA_HOST;
  const port = Number(env.CONCORDIA_PORT);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return deny('Cc: 選定接続先が不明です。親モデルへ継承せず停止しました。');
  }
  try {
    const selected = await requestSelection(task, host, port, request);
    return deny('Ccの既存タスク選定: ' + JSON.stringify(selected) + '。このAgentは未起動です。' +
      '親モデル継承を避け、既存のConcordia delegation_invokeで同じ子タスクを委任してください。' +
      '選定call_nameとoverrides {provider,model,reasoning_effort}を使用し、元のpromptをargs.taskへ渡す。' +
      'テンプレートのinput_schemaを確認して必要引数を保持する。cwdと本人のparent_session_idを引き継ぐ。' +
      '受付run IDを確認し、結果不明なら再送前に既存runを照合する。委任ツールが無い場合は未実行として報告する。');
  } catch {
    return deny('Cc: 内部Agentのモデル選定を確認できません。未起動です。接続/候補を復旧後に再選定してください。');
  }
}
async function requestSelection(task, host, port, request) {
  const response = await request('http://' + (host === '::1' ? '[::1]' : host) + ':' + port + '/v1/delegation/internal-agent-selection', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ prompt: task.prompt, description: typeof task.description === 'string' ? task.description : '' }),
  });
  if (!response.ok) throw new Error('selection unavailable');
  const { selection: selected } = await response.json();
  if (!selected || !['call_name', 'provider', 'model', 'reasoning_effort'].every(k => typeof selected[k] === 'string' && selected[k])) {
    throw new Error('invalid selection');
  }
  return selected;
}

export async function main(stream = process.stdin) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += Buffer.byteLength(chunk);
      if (size > 65536) throw new Error('input too large');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
    process.stdout.write(JSON.stringify(await handleInternalAgent(input, process.env)));
  } catch {
    process.stdout.write(JSON.stringify(deny('Cc: Agent入力を確認できません。未起動です。')));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
