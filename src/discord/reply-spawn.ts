/**
 * src/discord/reply-spawn.ts — 返信を「補足 or 新セッション起動」に振り分ける。
 *
 * 方針 (ユーザ指定): session channel への **返信** は基本的にセッションへの情報補足で
 * あり、 走っている AI は一切反応しない (inject しない)。 ただし返信に **モデル指定や
 * 作業の追加指示** が含まれる場合は、 それを汲んで **新規セッションを 1 つ立てる**。
 * この判定は **Haiku** に行わせる (Concordia 自身は LLM を持たず、 headless claude を 1 ショット叩く)。
 *
 * 新セッションのプロンプト = 返信先メッセージ本文 (= 元の作業内容) + 返信の追加指示。
 * 起動は `/v1/admin/spawn-session` の prompt 経路 (provider 直 + 自由テキスト prompt)。
 *
 * 副作用 (LLM 実行 / HTTP spawn) は注入可能にして純粋ロジックを単体テストできるようにする。
 * SRP: 判定プロンプトの組み立て + 判定結果の解釈 + spawn 呼び出しのみ。
 */
import { runClaude, extractJson } from "../rules/claude-runner.js";

/** Haiku 判定の結果。 */
export interface ReplyJudgment {
  /** true = 新規セッションを立てるべき (モデル指定 or 作業指示あり)。 */
  spawn: boolean;
  /** 返信で指定されたモデル (例 "haiku"/"sonnet"/"opus")。 無ければ null。 */
  model: string | null;
  /** 返信から抽出した追加作業指示 (spawn=false なら空でよい)。 */
  instructions: string;
}

/** 判定に使う headless ランナー (テストで差し替え可能)。 */
export type HeadlessRun = (prompt: string, opts: { model?: string }) => Promise<{ ok: boolean; stdout: string }>;

/** spawn 実行 (テストで差し替え可能)。 戻り値は ok と任意のエラー。 */
export type SpawnCaller = (body: {
  provider: string;
  cwd?: string;
  prompt: string;
  model?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export interface MaybeSpawnInput {
  /** 返信メッセージ本文 (= モデル指定 / 追加指示を含みうる)。 */
  replyText: string;
  /** 返信先メッセージ本文 (= 元の作業内容)。 不明なら空文字。 */
  repliedToText: string;
  /** 返信先セッションの作業ディレクトリ (新セッションの cwd)。 null 可。 */
  repoPath: string | null;
}

export interface MaybeSpawnDeps {
  /** Haiku 判定ランナー。 既定は runClaude。 */
  run?: HeadlessRun;
  /** spawn 実行。 */
  spawn: SpawnCaller;
  /** 判定モデル (既定 haiku)。 */
  judgeModel?: string;
  /** 新セッションの provider (既定 claude)。 */
  spawnProvider?: string;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

const JUDGE_INSTRUCTIONS =
  `あなたは Discord 返信を分類する 1 ショット判定器です。 出力は JSON 1 個のみ (説明文なし)。\n` +
  `session channel への「返信」を受け取ります。 返信は基本的に走っているセッションへの情報補足で、 ` +
  `その場合は何もしません。 ただし返信が「別モデルでやり直す」「これも追加でやって」等の ` +
  `**モデル指定や新しい作業指示**を含むなら、 新規セッションを立てるべきと判定します。\n\n` +
  `次の JSON だけを出力してください:\n` +
  `{"spawn": <bool>, "model": <string|null>, "instructions": <string>}\n` +
  `- spawn: 新規セッションを立てるべきなら true。 単なる補足/相槌/情報追加だけなら false。\n` +
  `- model: 返信で指定されたモデル名 (haiku/sonnet/opus/claude-* 等)。 指定が無ければ null。\n` +
  `- instructions: 返信から読み取れる追加の作業指示 (無ければ "")。`;

/** 判定プロンプトを組み立てる (純粋)。 */
export function buildJudgePrompt(input: MaybeSpawnInput): string {
  return (
    `${JUDGE_INSTRUCTIONS}\n\n` +
    `--- 返信先メッセージ (元の作業内容) ---\n"""\n${input.repliedToText.slice(0, 3000)}\n"""\n\n` +
    `--- 返信 (これを分類) ---\n"""\n${input.replyText.slice(0, 2000)}\n"""\n`
  );
}

/** Haiku 出力 (JSON) を ReplyJudgment に正規化する (壊れていれば spawn=false)。 */
export function parseJudgment(stdout: string): ReplyJudgment {
  const json = extractJson(stdout);
  if (!json || typeof json !== "object") return { spawn: false, model: null, instructions: "" };
  const o = json as Record<string, unknown>;
  return {
    spawn: o.spawn === true,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : null,
    instructions: typeof o.instructions === "string" ? o.instructions.trim() : "",
  };
}

/** 新セッションへ渡す初回プロンプトを組み立てる (純粋)。 */
export function buildSpawnPrompt(input: MaybeSpawnInput, judgment: ReplyJudgment): string {
  const parts = [
    `# 引き継ぎ作業 (Discord 返信由来)`,
    `別セッションでの作業を引き継ぎ、 以下を進めてください。 余計な確認はせず素直に着手して構いません。`,
  ];
  if (input.repliedToText.trim()) {
    parts.push(`\n## 元の内容 (返信先メッセージ)\n"""\n${input.repliedToText.slice(0, 6000)}\n"""`);
  }
  if (judgment.instructions) {
    parts.push(`\n## 追加指示 (返信)\n${judgment.instructions}`);
  } else if (input.replyText.trim()) {
    parts.push(`\n## 追加指示 (返信)\n${input.replyText.slice(0, 2000)}`);
  }
  return parts.join("\n");
}

/**
 * 返信を判定し、 必要なら新規セッションを spawn する。
 * 戻り値 `spawned=false` は「補足扱い (何もしない)」。
 */
export async function maybeSpawnFromReply(
  deps: MaybeSpawnDeps,
  input: MaybeSpawnInput,
): Promise<{ spawned: boolean; reason: string; model?: string }> {
  const run = deps.run ?? ((p, o) => runClaude(p, o));
  const log = deps.log ?? { info: () => {}, warn: () => {} };

  // 空返信は補足ですらない → 何もしない。
  if (!input.replyText.trim()) return { spawned: false, reason: "empty reply" };

  let judgment: ReplyJudgment;
  try {
    const res = await run(buildJudgePrompt(input), { model: deps.judgeModel ?? "haiku" });
    if (!res.ok) {
      log.warn(`reply-spawn: judge run failed → 補足扱い`);
      return { spawned: false, reason: "judge failed" };
    }
    judgment = parseJudgment(res.stdout);
  } catch (e) {
    log.warn(`reply-spawn: judge error (${(e as Error).message}) → 補足扱い`);
    return { spawned: false, reason: "judge error" };
  }

  if (!judgment.spawn) {
    log.info(`reply-spawn: 補足扱い (spawn=false)`);
    return { spawned: false, reason: "supplementary" };
  }

  const prompt = buildSpawnPrompt(input, judgment);
  try {
    const r = await deps.spawn({
      provider: deps.spawnProvider ?? "claude",
      cwd: input.repoPath ?? undefined,
      prompt,
      model: judgment.model ?? undefined,
    });
    if (!r.ok) {
      log.warn(`reply-spawn: spawn failed: ${r.error ?? "unknown"}`);
      return { spawned: false, reason: `spawn failed: ${r.error ?? "unknown"}` };
    }
    log.info(`reply-spawn: spawned new session model=${judgment.model ?? "default"}`);
    return { spawned: true, reason: "spawned", model: judgment.model ?? undefined };
  } catch (e) {
    log.warn(`reply-spawn: spawn error: ${(e as Error).message}`);
    return { spawned: false, reason: "spawn error" };
  }
}
