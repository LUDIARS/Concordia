/**
 * 巡回チャットの学習の記録を Memoria の日記へ載せる (spec/feature/patrol-chat.md 「学習の記録」)。
 *
 * - その日の全 rule の学習 run を 1 つの節 (source = concordia-patrol-learning) にまとめ、 節ごと置き換える。
 *   同じ日に何度書いても同じ内容になるので、 再送しても重複しない
 * - 学習に使った会話 (断片の元の発言) も載せる。 発言者の名前は載せない
 * - 直近の学習した日 (既定 7 日) を見て、 書けた内容の署名と違う日だけ送る。 送れなかったら次の pass で送り直す。
 *   起動直後は署名が無いので、 既にある日の分もここで載る
 * - 記録の正本は Cc の patrol_learning_runs。 Memoria は閲覧用の写し
 */

import type { LearningRunRow, LearningSourceRow, PatrolLearningRepo } from "../db/patrol-learning-repo.js";
import type { MemoriaJournalPort } from "../daily-goal-run/memoria-journal.js";

export const PATROL_LEARNING_JOURNAL_SOURCE = "concordia-patrol-learning";
/** 載せ直しを確かめる直近の日数。 */
export const PATROL_LEARNING_JOURNAL_DAYS = 7;

const STATUS_LABEL: Record<LearningRunRow["status"], string> = {
  applied: "反映した",
  skipped: "見送り",
  rejected: "却下",
  failed: "失敗",
};

const CHANGE_LABEL: Record<string, string> = {
  prefer_genres: "優先するジャンル",
  prefer_ratio: "優先の割合",
  tick_sec: "投稿の間隔 (秒)",
  root_limit_per_day: "1 日の投稿上限",
  learned_instructions: "学んだ方針",
  learned_keywords: "関心のある言葉",
  topic_keywords: "話題の言葉",
};

const QUOTE_MAX = 160;

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("、");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 1 行の引用にする (改行を詰め、 長いものは切る)。 */
function quote(text: string | null): string {
  if (text === null) return "(発言は残っていません)";
  const flat = text.replace(/\s+/g, " ").trim();
  return `「${flat.length <= QUOTE_MAX ? flat : `${flat.slice(0, QUOTE_MAX - 1)}…`}」`;
}

/** 会話の断片の要点 (返信数・反応の人数)。 */
function conversationSignal(raw: string | null): string {
  const s = parse(raw);
  if (!s) return "";
  const n = (key: string) => (typeof s[key] === "number" ? (s[key] as number) : 0);
  return ` (返信 ${n("replies")} 件・反応 ${n("reactors")} 人、 良い ${n("fine")} / 悪い ${n("bad")})`;
}

function renderSources(sources: readonly LearningSourceRow[]): string[] {
  if (sources.length === 0) return [];
  const lines = ["- 学習に使った会話:"];
  for (const s of sources) {
    if (s.kind === "message") {
      lines.push(`  - 発言 ${quote(s.text)}${s.reply_to_text !== null ? ` ← 返信先 ${quote(s.reply_to_text)}` : ""}`);
    } else {
      lines.push(`  - 投稿 ${quote(s.text)}${conversationSignal(s.signal)}`);
      for (const reply of s.replies) lines.push(`    - 返信 ${quote(reply)}`);
    }
  }
  return lines;
}

/** 日記の 1 節。 その日の rule ごとに結果・要約・実際に変えた設定・使った会話を書く。 */
export function renderLearningJournal(
  day: string,
  runs: readonly LearningRunRow[],
  sourcesOf: (runId: string) => readonly LearningSourceRow[] = () => [],
): { title: string; markdown: string } {
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(`### ${run.rule_id} — ${STATUS_LABEL[run.status] ?? run.status}`);
    const proposal = parse(run.proposal);
    const summary = typeof proposal?.summary === "string" && proposal.summary ? proposal.summary : null;
    if (summary) lines.push(`- 要約: ${summary}`);
    if (run.reason && run.reason !== summary) lines.push(`- 理由: ${run.reason}`);
    lines.push(`- 材料にした断片: ${run.fragment_count} 件`);
    const applied = parse(run.applied);
    if (applied && Object.keys(applied).length > 0) {
      lines.push("- 変えた設定:");
      for (const [key, value] of Object.entries(applied)) lines.push(`  - ${CHANGE_LABEL[key] ?? key}: ${formatValue(value)}`);
    }
    if (run.revision !== null) lines.push(`- 反映後の版: rev ${run.revision}`);
    lines.push(...renderSources(sourcesOf(run.run_id)));
    lines.push("");
  }
  return { title: `巡回チャットの学習 (${day})`, markdown: lines.join("\n").trim() };
}

export interface LearningJournalSync {
  /** 直近の学習した日のうち、 前回送った内容から変わった日を Memoria へ送る。 */
  sync(): Promise<void>;
}

export function createLearningJournalSync(deps: {
  repo: Pick<PatrolLearningRepo, "listRunsByDay" | "recentLearningDays" | "sourcesForRun">;
  journal: Pick<MemoriaJournalPort, "putDiarySection">;
  days?: number;
  log?: { warn: (msg: string) => void };
}): LearningJournalSync {
  const sent = new Map<string, string>();
  return {
    async sync() {
      const days = deps.repo.recentLearningDays(deps.days ?? PATROL_LEARNING_JOURNAL_DAYS);
      // 見る範囲から外れた日の署名は持たない
      for (const day of [...sent.keys()]) if (!days.includes(day)) sent.delete(day);
      for (const day of days) {
        const runs = deps.repo.listRunsByDay(day);
        if (runs.length === 0) continue;
        const signature = runs.map((r) => `${r.run_id}:${r.status}`).join("|");
        if (sent.get(day) === signature) continue;
        const body = renderLearningJournal(day, runs, (runId) => deps.repo.sourcesForRun(runId));
        const result = await deps.journal.putDiarySection(day, PATROL_LEARNING_JOURNAL_SOURCE, body);
        if (result.ok) {
          sent.set(day, signature);
          continue;
        }
        deps.log?.warn(`patrol learning journal: memoria ${result.kind} (${day}): ${result.error}`);
        // 届かないときは残りの日も同じ結果になりやすいので、 次の pass に回す
        return;
      }
    },
  };
}
