import { describe, expect, it, vi } from 'vitest';
import { gateActionFrom, localShellVerdict, preToolOutput, runConsultCodexHook } from './consult-codex-hook.mjs';

const env = { CONCORDIA_SESSION_ID: 'lictor-consult-1', CONCORDIA_URL: 'http://cc.test' };
const ok = (body) => ({ ok: true, json: async () => body });

describe('consult codex hook', () => {
  it('PreToolUse を Cc のハーネス判定へ渡し、 deny なら codex の deny 出力を返す', async () => {
    const fetchImpl = vi.fn(async () => ok({ decision: 'deny', reason: '予算を使い切ったので作業を止めます。' }));
    const write = vi.fn();
    await runConsultCodexHook({
      event: 'pre-tool', env, fetchImpl, write,
      input: { tool_name: 'web_search', tool_input: { query: 'x' }, cwd: 'E:/Document/Consult/designer' },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://cc.test/v1/harness/gate');
    expect(JSON.parse(init.body)).toEqual({
      action: { tool: 'web_search', cwd: 'E:/Document/Consult/designer' },
      session_id: 'lictor-consult-1', hook: 'consult-codex-pre-tool',
    });
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '予算を使い切ったので作業を止めます。' },
    });
  });

  it('許可・Cc に届かないときは何も出さない (ツールを止めない)', async () => {
    const write = vi.fn();
    await runConsultCodexHook({ event: 'pre-tool', env, write, input: {}, fetchImpl: async () => ok({ decision: 'allow' }) });
    await runConsultCodexHook({ event: 'pre-tool', env, write, input: {}, fetchImpl: async () => { throw new Error('down'); } });
    await runConsultCodexHook({ event: 'pre-tool', env, write, input: {}, fetchImpl: async () => ({ ok: false }) });
    expect(write).not.toHaveBeenCalled();
  });

  it('SessionStart の transcript_path を Cc のセッションへ報告する', async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    await runConsultCodexHook({
      event: 'session-start', env, fetchImpl, write: vi.fn(),
      input: { transcript_path: 'E:/Document/Consult/.codex-home/sessions/2026/10/03/rollout-a.jsonl' },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://cc.test/v1/sessions/lictor-consult-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ transcript_path: 'E:/Document/Consult/.codex-home/sessions/2026/10/03/rollout-a.jsonl' });
  });

  it('Cc のセッション id が無ければ何もしない', async () => {
    const fetchImpl = vi.fn();
    await runConsultCodexHook({ event: 'pre-tool', env: {}, fetchImpl, input: {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('シェルは公開リンクの取得コマンドだけを通し、 ほかは Cc に聞かずに止める (Cc が無くても止める)', async () => {
    const script = 'E:/Document/Consult/_source/tools/fetch-link/fetch-link.mjs';
    const shellEnv = { ...env, CONCORDIA_CONSULT_FETCH_LINK_SCRIPT: script };
    const fetchImpl = vi.fn(async () => ok({ decision: 'allow' }));
    const write = vi.fn();
    await runConsultCodexHook({
      event: 'pre-tool', env: shellEnv, fetchImpl, write,
      input: { tool_name: 'Bash', tool_input: { command: 'type E:\\Document\\Consult\\engineer\\AGENTS.md' } },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0][0]).hookSpecificOutput.permissionDecision).toBe('deny');

    write.mockClear();
    await runConsultCodexHook({
      event: 'pre-tool', env: shellEnv, fetchImpl, write,
      input: { tool_name: 'Bash', tool_input: { command: `node ${script} 'https://www.notion.so/Page-0123'` } },
    });
    expect(write).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 起動 env に取得スクリプトが無い・セッション id が無いときも、 シェルは止める。
    expect(localShellVerdict({ tool_name: 'Bash', tool_input: { command: `node ${script} 'https://www.notion.so/Page-0123'` } }, {}))
      .toMatchObject({ decision: 'deny' });
    write.mockClear();
    await runConsultCodexHook({ event: 'pre-tool', env: {}, write, input: { tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch' } } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(localShellVerdict({ tool_name: 'web_search', tool_input: { query: 'x' } }, shellEnv)).toBeNull();
    // ツール制限を外した部署 (consult_tools=all) はシェルを止めない (内容の判定は Cc に任せる)。
    expect(localShellVerdict({ tool_name: 'Bash', tool_input: { command: 'ls -a' } }, { CONCORDIA_CONSULT_ALL_TOOLS: '1' })).toBeNull();
    expect(localShellVerdict({ tool_name: 'Bash', tool_input: { command: 'ls -a' } }, { CONCORDIA_CONSULT_ALL_TOOLS: '0' }))
      .toMatchObject({ decision: 'deny' });
  });

  it('シェルの command 配列も 1 本の文字列にする', () => {
    expect(gateActionFrom({ tool_name: 'shell', tool_input: { command: ['ls', '-a'] } })).toEqual({ tool: 'shell', command: 'ls -a' });
    expect(preToolOutput({ decision: 'warn' })).toBeNull();
  });
});
