/**
 * Cr が token を inactive と答えた (失効・grant 取消)。再配送しても通らないので拒否として扱う。
 * これ以外の introspection 失敗 (到達不可・応答異常) は一時障害として再配送に回す。
 */
export class WorkloadTokenInactiveError extends Error {
  constructor() {
    super('workload_token_inactive');
    this.name = 'WorkloadTokenInactiveError';
  }
}

/** module の再読込でクラスが別実体になっても判定できるよう、名前で見る。 */
export function isWorkloadTokenInactive(error: unknown): boolean {
  return error instanceof Error && error.name === 'WorkloadTokenInactiveError';
}
