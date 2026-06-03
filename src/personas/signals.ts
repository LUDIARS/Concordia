/**
 * 投稿者 (セッション) の活動シグナルを収集する.
 *
 * 「投稿した人間の情報を集めてペルソナを作る」 の前段. セッションの作業プロファイル
 * (= それを操作している人間の働き方が反映される) を、 events / chat / session メタから
 * 一つの構造体にまとめる. ここでは収集と整形だけを行い、 人格の合成は generate.ts が担う.
 */

import type { SessionRow, SessionEventRow } from "../shared/types.js";
import type { ChatRepo } from "../db/chat-repo.js";
import { predictRole } from "../role/predict.js";

export interface PersonaSignals {
  session_id: string;
  /** rule ベースで推定した seed ロール名 (合成のたたき台). */
  role_label: string;
  provider: string;
  repo_base: string;
  branch: string | null;
  current_task: string | null;
  prompt_count: number;
  edit_count: number;
  /** 呼び出し回数の多い tool 上位 (降順, 最大 5). */
  dominant_tools: string[];
  /** 編集ファイルの傾向ラベル (例 "test", "infra", "spec", "src"). 多い順. */
  file_focus: string[];
  /** このセッションの chat に出た発言者名 (system 除く, 重複なし, 最大 8). */
  voices: string[];
  /** 直近の chat 抜粋 (時系列, 最大 20 行). */
  chat_samples: string[];
}

interface CollectDeps {
  chat: ChatRepo;
}

/** event payload を安全に JSON parse. */
function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

function repoBaseName(repoPath: string): string {
  return repoPath.split(/[/\\]/).filter(Boolean).pop() ?? repoPath;
}

/**
 * file パスを傾向バケットに振り分ける. predict.ts の正規表現と意図的に揃えている
 * (片方を直したら両方見直す).
 */
function fileBucket(file: string): string | null {
  if (/(^|\/)tests?\//i.test(file) || /\.test\.[a-z]+$/i.test(file)) return "test";
  if (/(^|\/)(infra|deploy|docker|k8s|ops)\//i.test(file)) return "infra";
  if (/(^|\/)spec\//i.test(file) || /\.md$/i.test(file)) return "spec";
  if (/(^|\/)src\//i.test(file)) return "src";
  return null;
}

/** count map を多い順に key 配列へ. */
function topKeys(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

export function collectSignals(
  deps: CollectDeps,
  session: SessionRow,
  events: SessionEventRow[],
): PersonaSignals {
  let promptCount = 0;
  let editCount = 0;
  const toolCounts = new Map<string, number>();
  const fileBuckets = new Map<string, number>();

  for (const ev of events) {
    if (ev.kind === "prompt") promptCount++;
    if (ev.kind === "edit") {
      editCount++;
      const file: string = safeParse(ev.payload)?.file ?? "";
      const bucket = file ? fileBucket(file) : null;
      if (bucket) fileBuckets.set(bucket, (fileBuckets.get(bucket) ?? 0) + 1);
    }
    if (ev.kind === "tool_call") {
      const name: string = safeParse(ev.payload)?.tool ?? "";
      if (name) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }

  // session-scope の chat から発言者名 + 抜粋を集める.
  // 抜粋は id 昇順 (= 挿入順 = 時系列) でソートし直近 20 件を取る.
  // ts だけだと同秒内の順序が不定になるため、 安定キーである autoincrement id を使う.
  const msgs = deps.chat
    .list({ limit: 200 })
    .filter((m) => m.session_id === session.id && m.channel !== "system");
  const voiceSet = new Set<string>();
  for (const m of msgs) {
    if (m.author_label) voiceSet.add(m.author_label);
  }
  const chatSamples = [...msgs]
    .sort((a, b) => a.id - b.id)
    .map((m) => `[${m.channel}] ${m.author_label}: ${m.text.slice(0, 120)}`)
    .slice(-20);

  return {
    session_id: session.id,
    role_label: predictRole(events),
    provider: session.provider,
    repo_base: repoBaseName(session.repo_path),
    branch: session.branch,
    current_task: session.current_task,
    prompt_count: promptCount,
    edit_count: editCount,
    dominant_tools: topKeys(toolCounts, 5),
    file_focus: topKeys(fileBuckets, 4),
    voices: [...voiceSet].slice(0, 8),
    chat_samples: chatSamples,
  };
}
