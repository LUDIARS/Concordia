/**
 * プライベート相談の後始末の判断 (spec/feature/tech-consultation.md §7、 2026-10-02 neco 指示)。
 *
 * 相談チャンネルは、 起動から 24 時間が経つか、 セッションの終了を検知したら閉じる。 閉じた後、
 * 会話がセンシティブでなく公開できると判断したときだけ「この内容を全体共有しますか？」を出す。
 * 相談者の反応が 24 時間なければ「共有しない」とみなす。 答えが出たらチャンネルを削除する。
 *
 * ここは判断だけを持つ純関数。 セッションの停止・判定の実行・投稿・削除は呼び出し側が行う。
 *
 * @implements SPEC-CONSULT-CLOSURE
 */

export const CONSULT_SESSION_MAX_MS = 24 * 60 * 60 * 1000;
export const SHARE_ANSWER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 判定に渡す会話の上限 (新しい側を残す)。 */
export const MAX_JUDGE_TRANSCRIPT_CHARS = 30_000;

export interface ConsultationClock {
  status: "pending_approval" | "open" | "closed";
  approved_at: number | null;
  created_at: number;
}

/** 起動から 24 時間を過ぎた、 まだ開いている相談か。 */
export function isConsultationOverdue(consultation: ConsultationClock, now: number): boolean {
  if (consultation.status !== "open") return false;
  return (consultation.approved_at ?? consultation.created_at) + CONSULT_SESSION_MAX_MS <= now;
}

/** 共有の問いに 24 時間答えがないか。 */
export function isShareAnswerOverdue(askedAt: number, now: number): boolean {
  return askedAt + SHARE_ANSWER_TIMEOUT_MS <= now;
}

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

/** 判定に渡す会話。 上限を超えたら古い側を落とす。 */
export function renderConsultationTranscript(lines: readonly TranscriptLine[]): string {
  const rendered = lines
    .filter((line) => line.text.trim())
    .map((line) => `${line.role === "user" ? "相談者" : "回答"}: ${line.text.trim()}`)
    .join("\n\n");
  return rendered.length > MAX_JUDGE_TRANSCRIPT_CHARS ? rendered.slice(-MAX_JUDGE_TRANSCRIPT_CHARS) : rendered;
}

export function buildShareJudgePrompt(transcript: string): string {
  return [
    "次は社内の技術相談の会話です。組織の全員に共有してよい知見かどうかを判断してください。",
    "共有してはいけないもの: 相談者や他の人が特定できる内容、社内固有の事情・プロジェクト名・製品名・取引先、",
    "秘密、人の評価、個人的な悩み。これらに触れずに書き直せない会話は共有しない。",
    "共有できるなら、会話を転載せずに一般的な知見として書き直した題名 (60 文字以内) と本文 (Markdown、2000 文字以内) を作る。",
    "出力は JSON 1 個だけ: {\"publishable\": true|false, \"title\": \"...\", \"summary\": \"...\", \"reason\": \"...\"}",
    "",
    "--- 会話 ---",
    transcript,
  ].join("\n");
}

export interface ShareJudgement {
  publishable: boolean;
  title: string;
  summary: string;
}

/** 判定の出力を読む。 読めない・項目が欠けるときは「共有しない」(公開側へ倒さない)。 */
export function parseShareJudgement(stdout: string): ShareJudgement {
  const notPublishable: ShareJudgement = { publishable: false, title: "", summary: "" };
  const match = /\{[\s\S]*\}/.exec(stdout);
  if (!match) return notPublishable;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return notPublishable;
  }
  if (!parsed || typeof parsed !== "object") return notPublishable;
  const value = parsed as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (value.publishable !== true || !title || !summary) return notPublishable;
  return { publishable: true, title, summary };
}

/**
 * 公開候補に社内の語 (秘匿語辞書・Cc に登録されたプロジェクト名) が残っていないかを見る。
 * 3 文字未満の語は誤検出が多いので見ない。 当たった語の位置ではなく件数だけを返す (語を記録に残さない)。
 */
export function countLeakedTerms(text: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const term of new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3))) {
    if (haystack.includes(term)) hits += 1;
  }
  return hits;
}

/**
 * 後始末の見回りは毎朝 1 回でよい (2026-10-02 neco 指示「24 時間の掃除も毎朝の確認で行うので、
 * 厳密には 24 時間以上放置されていても問題はない」)。 local の日付ごとに、 指定時刻を過ぎた最初の確認で 1 回だけ回す。
 */
export function dailySweepDay(nowMs: number, hour: number, lastRunDay: string | null): string | null {
  const now = new Date(nowMs);
  if (now.getHours() < hour) return null;
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return day === lastRunDay ? null : day;
}
