/** Pure action and result schema for deterministic harness policy. */
export type Decision = "allow" | "deny" | "warn";

export interface HarnessAction {
  /** 試行ツール (Edit | Write | MultiEdit | NotebookEdit | Bash | ...)。 */
  tool: string;
  /** Bash のコマンドライン (tool=Bash のとき)。 */
  command?: string;
  /** 編集対象ファイルの絶対パス (編集系ツールのとき)。 */
  filePath?: string;
  /** 操作の作業ディレクトリ / リポジトリルート。 */
  cwd?: string;
  /** Anatomia/Concordia プロジェクト名 (任意)。 */
  project?: string;
  /** 対象リポの現在ブランチ (hook が git で解決して渡す。 不明なら省略)。 */
  branch?: string;
  /** 当該セッションでこれまでに編集したリポ root の集合 (5 リポ警告用)。 */
  editedRepos?: string[];
  /**
   * このセッションが宣言した作業対象プロジェクト / リポ (スコープ基準)。 gate ハンドラが
   * session の `target_project` (明示) → 無ければ登録時 `repo_path` (暗黙) の順で解決して渡す。
   * これと現在編集中のリポが食い違うとき {@link outsideScope} が警告する。 未解決なら省略。
   */
  targetProject?: string;
  /** cwd が linked worktree と解決できた場合 true。未解決なら省略。 */
  isWorktree?: boolean;
  /** session 登録情報由来の provider/model 識別子。未解決なら省略。 */
  sessionModel?: string;
  /** 人間承認により当該 session の強推論モデル実装ゲートを解除済み。 */
  implUnlocked?: boolean;
  /** session contract が全フィールド確定済み。未確定はコード編集を fail-closed deny。 */
  contractComplete?: boolean;
  contractScopeDirs?: string[];
  editedFiles?: string[];
  /**
   * 問診セッション (director-inquiry-session.md §3) として起動された。
   * true のときだけ読み取り専用契約を強制する。判定できないときは undefined。
   */
  readOnlyInquiry?: boolean;
  /** 問診が所有する Director case。書き込み API の case 境界に使う。 */
  inquiryCaseId?: string;
  /** 問診に許可する Concordia API origin。外部 URL への curl を拒否する。 */
  inquiryApiBaseUrl?: string;
  /** 問診がファイルを読める、run 起動時に解決済みの target_repo。 */
  inquiryReadRoot?: string;
  /** 問診が GET できる、所有 case の step に紐づいた delegation run。 */
  inquiryAllowedRunIds?: string[];
  /**
   * セッションの部署のユースケースが read-only (spec/feature/dialogue-context.md §3)。
   * true のときだけ編集と git の書き込みを拒否する。 判定できないときは undefined。
   */
  useCaseReadOnly?: boolean;
  /** チーム所属セッションの team settings (teams §3.1)。 未所属は undefined。 */
  teamTestPolicy?: "confirm-queue" | "custos-unity";
  teamWorktreePolicy?: "allowed" | "repo-root-only";
  teamVisibility?: "public" | "private";
}

export interface PredicateHit {
  /** 述語キー (監査ログの rule 列に入る)。 */
  rule: string;
  decision: Exclude<Decision, "allow">;
  reason: string;
  /** 解消のための助言 (任意)。 */
  suggestion?: string;
}

export type Predicate = (a: HarnessAction) => PredicateHit | null;
