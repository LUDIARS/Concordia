/**
 * テストフォーラム投稿の操作面 (テスト開始 / provider・effort 選択 / マージ)。
 *
 * 状態遷移とボタン定義だけを持つ純粋モジュール。 Discord API も spawn も触らない
 * (それらは test-forum-actions.ts)。 customId の組み立てと解釈をここに集約するので、
 * 送る側と受ける側で書式がずれない。
 *
 * 状態:
 *   candidate — Revisor が Open / Test OK にした直後。 「テスト開始」を出す
 *   testing   — セッション起動済み。 ボタンは「マージ」に変わる
 *   merged    — マージ済み。 操作は出さない
 *
 * @implements spec/feature/test-forum-controls.md — 状態遷移
 */

/** provider は Concordia の spawn プリセットと同じ語彙。 */
export type TestProvider = "codex" | "claude";
export type TestEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TestRunConfig {
  provider: TestProvider;
  /** provider 内のモデル別名 (codex の sol 等)。 空なら provider 既定。 */
  model: string;
  effort: TestEffort;
}

/**
 * 既定は codex の Sol・xhigh (neco 指定 2026-07-31)。 テスト確認は「見落とさないこと」が
 * 価値なので、 既定は最も強い設定に置く。 軽く回したいときだけ選択で下げる。
 */
export const DEFAULT_TEST_RUN_CONFIG: TestRunConfig = {
  provider: "codex",
  model: "sol",
  effort: "xhigh",
};

export const TEST_PROVIDER_CHOICES: ReadonlyArray<{ value: string; label: string; config: TestRunConfig }> = [
  { value: "codex:sol", label: "Codex Sol", config: { provider: "codex", model: "sol", effort: "xhigh" } },
  { value: "codex:", label: "Codex (既定モデル)", config: { provider: "codex", model: "", effort: "xhigh" } },
  { value: "claude:opus", label: "Claude Opus", config: { provider: "claude", model: "opus", effort: "high" } },
  { value: "claude:sonnet", label: "Claude Sonnet", config: { provider: "claude", model: "sonnet", effort: "high" } },
];

const TEST_EFFORT_CHOICES: readonly TestEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * Claude Code の effort 語彙には `minimal` が無い (control/provider-preset.ts の
 * CLAUDE_REASONING_EFFORTS)。 選ばせたまま spawn 時に黙って捨てると、 投稿の表示と
 * 実際に走る設定が食い違うので、 provider ごとに選べる値そのものを絞る。
 */
const CLAUDE_EFFORT_CHOICES: readonly TestEffort[] = ["low", "medium", "high", "xhigh"];

export function testEffortChoices(provider: TestProvider): readonly TestEffort[] {
  return provider === "claude" ? CLAUDE_EFFORT_CHOICES : TEST_EFFORT_CHOICES;
}

/** その provider の spawn 引数として実際に効く effort かどうか。 */
export function isEffortSupported(provider: TestProvider, value: string): value is TestEffort {
  return (testEffortChoices(provider) as readonly string[]).includes(value);
}

export type TestSurfaceState = "candidate" | "starting" | "testing" | "merged";

/** customId の名前空間。 既存の `ctrl:` (コントロールパネル) とは別に切る。 */
const PREFIX = "test";

export type TestControlAction = "start" | "merge" | "provider" | "effort";

export function buildTestControlId(action: TestControlAction, surfaceId: number): string {
  return `${PREFIX}:${action}:${surfaceId}`;
}

export function parseTestControlId(
  customId: string,
): { action: TestControlAction; surfaceId: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const action = parts[1];
  if (action !== "start" && action !== "merge" && action !== "provider" && action !== "effort") {
    return null;
  }
  // Number() は "1e3" / " 1" / "0x10" も通す。 customId は自前で組んだ 10 進数しか
  // 出さないので、 受け側もその書式だけを認める。
  if (!/^[0-9]+$/.test(parts[2])) return null;
  const surfaceId = Number(parts[2]);
  if (!Number.isSafeInteger(surfaceId) || surfaceId <= 0) return null;
  return { action, surfaceId };
}

/** provider 選択値 (`codex:sol` 形式) を設定へ。 未知値は既定へ落とす。 */
export function parseProviderChoice(value: string): TestRunConfig {
  const hit = TEST_PROVIDER_CHOICES.find((choice) => choice.value === value);
  return hit ? { ...hit.config } : { ...DEFAULT_TEST_RUN_CONFIG };
}

export function providerChoiceValue(config: TestRunConfig): string {
  return `${config.provider}:${config.model}`;
}

/**
 * その状態で出すべき操作。 「テスト開始」を押すと同じ場所が「マージ」になる、 という
 * 要求をここ 1 箇所で表す (描画側は素直に従うだけ)。
 */
export interface TestControlLayout {
  /** 主ボタン。 null なら操作を出さない (merged)。 */
  primary: { action: "start" | "merge"; label: string; style: "primary" | "success" } | null;
  /** provider / effort の選択を出すか (テスト開始前だけ調整できる)。 */
  selectors: boolean;
}

export function testControlLayout(state: TestSurfaceState): TestControlLayout {
  switch (state) {
    case "candidate":
      return { primary: { action: "start", label: "テスト開始", style: "primary" }, selectors: true };
    case "starting":
      // session.started で session_id が確定するまでは二重起動もマージも許可しない。
      return { primary: null, selectors: false };
    case "testing":
      // 起動後に provider を変えても走っているセッションは変わらないので選択は畳む。
      return { primary: { action: "merge", label: "マージ", style: "success" }, selectors: false };
    case "merged":
      return { primary: null, selectors: false };
  }
}

/** 投稿本文に出す現在の設定行 (選択が効いていることを人間が確認できるようにする)。 */
export function describeRunConfig(config: TestRunConfig): string {
  const model = config.model ? `${config.provider}/${config.model}` : config.provider;
  return `**実行設定** \`${model}\` · effort \`${config.effort}\``;
}
