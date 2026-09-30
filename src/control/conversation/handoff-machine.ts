/**
 * 実行セッション交代 (handoff) の状態遷移と、交代を保留する条件 (純関数)。
 *
 * 交代は active → handoff_pending → handoff_saved → successor_requested →
 * successor_ready → routing_switched → predecessor_drained の順に進む。
 * 各遷移は外部副作用 (起動・受信先切替・終了要求) の前に保存する。
 * routing_switched より前なら中断して旧担当へ戻せる。 切替後は戻さない
 * (停止済み担当を無条件で復活させない)。
 *
 * @implements spec/feature/astra-with-sidecar.md §会話と実行の寿命 / §不変条件と復旧
 */

export const HANDOFF_STATES = [
  "handoff_pending",
  "handoff_saved",
  "successor_requested",
  "successor_ready",
  "routing_switched",
  "predecessor_drained",
  "aborted",
  "failed",
] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

export type HandoffEvent =
  | "package_saved"
  | "successor_requested"
  | "successor_ready"
  | "routing_switched"
  | "predecessor_drained"
  | "abort"
  | "fail";

const TRANSITIONS: Record<HandoffState, Partial<Record<HandoffEvent, HandoffState>>> = {
  handoff_pending: { package_saved: "handoff_saved", abort: "aborted", fail: "failed" },
  handoff_saved: { successor_requested: "successor_requested", abort: "aborted", fail: "failed" },
  successor_requested: { successor_ready: "successor_ready", abort: "aborted", fail: "failed" },
  successor_ready: { routing_switched: "routing_switched", abort: "aborted", fail: "failed" },
  routing_switched: { predecessor_drained: "predecessor_drained" },
  predecessor_drained: {},
  aborted: {},
  failed: {},
};

export function nextHandoffState(current: HandoffState, event: HandoffEvent): HandoffState | null {
  return TRANSITIONS[current][event] ?? null;
}

/** 交代中 (受信を保留し、旧担当にも新規処理をさせない) か。 */
export function isHandoffInFlight(state: HandoffState): boolean {
  return state === "handoff_pending" || state === "handoff_saved"
    || state === "successor_requested" || state === "successor_ready";
}

/** 旧担当へ戻して再開できる段階か。 受信先を切り替えた後は戻さない。 */
export function canReturnToPredecessor(state: HandoffState): boolean {
  return isHandoffInFlight(state);
}

export interface HandoffBlockerFacts {
  unansweredQuestions: number;
  unfinishedChildRuns: number;
  /** 審査中・マージ未確認の PR (draft / open)。 */
  openPullRequests: number;
  /** 配達結果が不明な入力。 */
  uncertainInputs: number;
  /** 実行中セッションの状態を確認できない (Cc の情報源が欠けている)。 */
  ownerUnknown: boolean;
}

export type HandoffBlocker =
  | "unanswered_question"
  | "unfinished_child_run"
  | "open_pull_request"
  | "uncertain_input"
  | "owner_unknown";

const BLOCKER_LABELS: Record<HandoffBlocker, string> = {
  unanswered_question: "未回答の質問",
  unfinished_child_run: "実行中の委託",
  open_pull_request: "審査中またはマージ未確認の PR",
  uncertain_input: "配達結果が不明な入力",
  owner_unknown: "現在の担当セッションの状態が確認できない",
};

/**
 * 自動交代を保留すべき事実。 MVP ではこれらが 1 つでもあれば交代しない
 * (未完了作業・人間待ち・結果不明の副作用を切替で消さないため)。
 */
export function evaluateHandoffBlockers(facts: HandoffBlockerFacts): HandoffBlocker[] {
  const blockers: HandoffBlocker[] = [];
  if (facts.ownerUnknown) blockers.push("owner_unknown");
  if (facts.unansweredQuestions > 0) blockers.push("unanswered_question");
  if (facts.unfinishedChildRuns > 0) blockers.push("unfinished_child_run");
  if (facts.openPullRequests > 0) blockers.push("open_pull_request");
  if (facts.uncertainInputs > 0) blockers.push("uncertain_input");
  return blockers;
}

export function describeHandoffBlockers(blockers: readonly HandoffBlocker[]): string {
  return blockers.map((blocker) => BLOCKER_LABELS[blocker]).join("、");
}
