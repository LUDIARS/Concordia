interface TestIsolationAction {
  tool: string;
  command?: string;
  isWorktree?: boolean;
  vibesClaimActive?: boolean;
  /** team settings `test_policy` (teams §3.1)。拒否時に正しい実行経路を案内する。 */
  teamTestPolicy?: "confirm-queue" | "custos-unity";
}

interface TestIsolationHit {
  rule: string;
  decision: "deny";
  reason: string;
  suggestion: string;
}

type TestIsolationPredicate = (action: TestIsolationAction) => TestIsolationHit | null;

const SERVICE_START = [
  /(?:^|[;&|]\s*)start-[\w-]+\.bat(?:\s|$)/i,
  /\bnpm\s+(?:run\s+)?dev(?:\s|$)/i,
  /\bnpm\s+start(?:\s|$)/i,
  /\bnode(?:\s+--?[\w-]+(?:=\S+)?)*\s+\S*dist[\\/][^\s]+/i,
];

const OP_TEST = [
  /\bnpm\s+run\s+(?:e2e|integration|integration_test)(?:\s|$)/i,
  /\bplaywright(?:\s|$)/i,
];

export function isServiceStartCommand(command: string): boolean {
  return SERVICE_START.some((pattern) => pattern.test(command));
}

export function isOperationalTestCommand(command: string): boolean {
  return isServiceStartCommand(command) || OP_TEST.some((pattern) => pattern.test(command));
}

export const noServiceStartInSession: TestIsolationPredicate = (action) => {
  if (action.vibesClaimActive === true) return null;
  if (action.tool !== "Bash" || !action.command || !isServiceStartCommand(action.command)) return null;
  return {
    rule: action.teamTestPolicy === "custos-unity" ? "custos-unity-required" : "no-service-start-in-session",
    decision: "deny",
    reason: "セッション内からサービスを起動しようとしています。",
    suggestion: action.teamTestPolicy === "custos-unity"
      ? "Unity の動作テストは Custos の管理経路から実行してください。セッション内の直接起動は許可されません。"
      : "サービス起動は Excubitor または confirm フロー経由で行ってください。",
  };
};

export const noOpTestInWorktree: TestIsolationPredicate = (action) => {
  if (action.vibesClaimActive === true) return null;
  if (action.isWorktree !== true || action.tool !== "Bash" || !action.command) return null;
  if (!isOperationalTestCommand(action.command)) return null;
  return {
    rule: action.teamTestPolicy === "custos-unity" ? "custos-unity-required" : "no-op-test-in-worktree",
    decision: "deny",
    reason: "worktree 内でサービス起動または動作テストを実行しようとしています。",
    suggestion: action.teamTestPolicy === "custos-unity"
      ? "Unity の動作テストは Custos の管理経路から実行してください。worktree からの直接実行は許可されません。"
      : "動作テストは安定ブランチの confirm フローで行ってください。vitest / npm test などの単体テストは実行できます。",
  };
};
