/**
 * 指令ブリッジの公開設定を env から読む (spec/feature/agent-instructions-bridge.md §公開)。
 * 設定ミスで Cc 全体を止めないよう throw せず、 問題は `problem` に返す。
 * 公開ホストが読めなくても、 トンネル由来ヘッダーで公開経由は捕まえる (鍵の判定は外さない)。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 公開設定
 */

export interface InstructionAccessConfig {
  publicHost: string | null;
  problem: string | null;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function readInstructionAccessConfig(env: Readonly<Record<string, string | undefined>>): InstructionAccessConfig {
  const rawHost = env.CONCORDIA_INSTRUCTIONS_PUBLIC_HOST?.trim().toLowerCase() ?? "";
  const publicHost = rawHost && HOSTNAME.test(rawHost) ? rawHost : null;
  const problem = rawHost && !publicHost ? "CONCORDIA_INSTRUCTIONS_PUBLIC_HOST はホスト名だけを書く (スキーム・ポート・パスは付けない)" : null;
  return { publicHost, problem };
}
