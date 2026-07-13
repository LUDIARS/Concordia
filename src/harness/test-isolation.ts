import type { Predicate } from "./predicates.js";

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

export const noServiceStartInSession: Predicate = (action) => {
  if (action.tool !== "Bash" || !action.command || !isServiceStartCommand(action.command)) return null;
  return {
    rule: "no-service-start-in-session",
    decision: "deny",
    reason: "セッション内からサービスを起動しようとしています。",
    suggestion: "サービス起動は Excubitor または confirm フロー経由で行ってください。",
  };
};

export const noOpTestInWorktree: Predicate = (action) => {
  if (action.isWorktree !== true || action.tool !== "Bash" || !action.command) return null;
  if (!isOperationalTestCommand(action.command)) return null;
  return {
    rule: "no-op-test-in-worktree",
    decision: "deny",
    reason: "worktree 内でサービス起動または動作テストを実行しようとしています。",
    suggestion: "動作テストは安定ブランチの confirm フローで行ってください。vitest / npm test などの単体テストは実行できます。",
  };
};
