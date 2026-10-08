/** Revisor wire DTOs shared by clients and pure lookup policy. */
/**
 * Revisor の local PR 1 件 (GET /v1/local-prs の pullRequests[])。 Revisor 側は
 * camelCase の JSON をそのまま返すので、 ここでは受け取った形に寄せて型付けする。
 * 未知フィールドは無視する (Revisor の進化で Concordia が落ちないようにする)。
 */
export interface RevisorLocalPr {
  id: string;
  number: number;
  repository: string;
  title: string;
  author: string;
  status: string;
  /** queued | running | test_ok | failed | action_required など。 */
  checkStatus: string;
  draft?: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  reviewedHeadSha?: string | null;
  reviewer?: string | null;
  labels?: string[];
  reasons?: string[];
  advisories?: string[];
  humanQuestion?: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  reviewLane?: "standard" | "fast";
}

export interface RevisorRepositoryRegistration {
  repository: string;
  rootPath: string;
  baseRef: string;
}

export interface RevisorLocalPrSummary {
  id: string;
  number: number;
  repository: string;
  headRef: string;
  status: string;
  checkStatus: string;
  sessionId?: string | null;
  reviewLane?: "standard" | "fast";
  /** 提出時の説明。 GitHub PR 本文へ「審査を通った説明」をそのまま載せるために使う。 */
  title?: string;
  body?: string;
}
