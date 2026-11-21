/**
 * 指令ブリッジの公開設定を env から読む (spec/feature/agent-instructions-bridge.md §公開)。
 * 設定ミスで Cc 全体を止めないよう throw せず、 問題は `problem` に返して公開経由を全部拒否する側に倒す。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 公開設定
 */

import { parseCfAccessConfig, type CfAccessConfig } from "../management/cf-access.js";

export interface InstructionAccessConfig {
  publicHost: string | null;
  access: CfAccessConfig | null;
  problem: string | null;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function readInstructionAccessConfig(env: Readonly<Record<string, string | undefined>>): InstructionAccessConfig {
  const rawHost = env.CONCORDIA_INSTRUCTIONS_PUBLIC_HOST?.trim().toLowerCase() ?? "";
  const publicHost = rawHost && HOSTNAME.test(rawHost) ? rawHost : null;
  const hostProblem = rawHost && !publicHost ? "CONCORDIA_INSTRUCTIONS_PUBLIC_HOST はホスト名だけを書く (スキーム・ポート・パスは付けない)" : null;
  try {
    const access = parseCfAccessConfig(env.CONCORDIA_INSTRUCTIONS_CF_ACCESS_TEAM_DOMAIN, env.CONCORDIA_INSTRUCTIONS_CF_ACCESS_AUD);
    return { publicHost, access, problem: hostProblem };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { publicHost, access: null, problem: hostProblem ?? `指令ブリッジの ${message}` };
  }
}
