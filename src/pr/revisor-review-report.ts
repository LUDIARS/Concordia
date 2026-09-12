/**
 * Revisor's persisted, human-readable review history; never accepts executable data.
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
export interface RevisorReviewReportEntry {
  id: string;
  kind: string;
  label: string;
  status: string;
  at: string;
  content: string;
}

export interface RevisorReviewReport {
  version: 1;
  attemptId: string;
  headSha: string;
  entries: readonly RevisorReviewReportEntry[];
}

export function parseReviewReport(value: unknown): RevisorReviewReport | null {
  if (value == null) return null; // Older Revisor versions do not expose history.
  if (typeof value !== "object") throw new Error("Invalid Revisor review report");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.attemptId !== "string" || !row.attemptId
    || typeof row.headSha !== "string" || !row.headSha || !Array.isArray(row.entries)) {
    throw new Error("Invalid Revisor review report envelope");
  }
  const entries = row.entries.map((raw): RevisorReviewReportEntry => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid Revisor review entry");
    const entry = raw as Record<string, unknown>;
    const { id, kind, label, status, at, content } = entry;
    if (typeof id !== "string" || !id || typeof kind !== "string"
      || typeof label !== "string" || typeof status !== "string"
      || typeof at !== "string" || !Number.isFinite(Date.parse(at)) || typeof content !== "string") {
      throw new Error("Invalid Revisor review entry fields");
    }
    return { id, kind, label, status, at, content };
  });
  return { version: 1, attemptId: row.attemptId, headSha: row.headSha, entries };
}
