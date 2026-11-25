/**
 * カードの出所を読む adapter (実装メモ 5)。出所の正本は変えず、読むだけ。
 * 出所ごとに読み取りを分け、1 つが読めなくても他は同期する。読めなかった出所は readable=false で返す (CC-V5-INV-03)。
 * 人間依頼 (human-command) は DB に記録が無いのでここでは読まない (human-command-cards.ts)。
 *
 * @implements spec/feature/control-cards.md — 出所
 */
import type Database from "better-sqlite3";
import { readHumanWait } from "../control/human-wait.js";
import {
  askCardItems,
  confirmPendingItems,
  directorBlockedItems,
  githubIssueApprovalItems,
  inquiryAskHumanItems,
  type InboxItem,
} from "../inbox/read-model.js";
import { pendingPlans } from "../inbox/pending-plans.js";
import type { DeskRequest } from "../desk/desk-request-policy.js";
import type { CardSourceItem, CardSourceKind } from "./card-domain.js";
import type { SourceReading } from "./card-sync-policy.js";
import { normalizeHumanAction } from "./human-action.js";

export interface CardSourcePorts {
  /** セッションのプロジェクト (project code)。分からなければ null。 */
  projectOf: (sessionId: string) => string | null;
  /** Web 画面のパスを開ける URL にする。 */
  webUrl: (path: string) => string;
  deskIssues?: () => DeskRequest[];
}

function inboxLink(item: InboxItem): string {
  if (item.kind === "director-blocked") return "/director";
  if (item.sessionId && (item.kind === "ask-card" || item.kind === "inquiry-ask-human")) return `/sessions/${item.sessionId}`;
  return "/inbox";
}

export function createCardSources(db: Database.Database, ports: CardSourcePorts) {
  const fromInbox = (kind: CardSourceKind, read: () => InboxItem[]) => (): CardSourceItem[] => read().map((item) => ({
    source_kind: kind,
    source_key: item.key,
    summary: item.summary,
    human_action: normalizeHumanAction(item.humanAction),
    raised_at: item.raisedAt,
    session_id: item.sessionId ?? null,
    project: item.sessionId ? ports.projectOf(item.sessionId) : null,
    link: ports.webUrl(inboxLink(item)),
  }));

  const readers: Array<[CardSourceKind, () => CardSourceItem[]]> = [
    ["ask-card", fromInbox("ask-card", () => askCardItems(db))],
    ["inquiry-ask-human", fromInbox("inquiry-ask-human", () => inquiryAskHumanItems(db))],
    ["director-blocked", fromInbox("director-blocked", () => directorBlockedItems(db))],
    ["confirm-pending", fromInbox("confirm-pending", () => confirmPendingItems(db))],
    ["github-issue-approval", fromInbox("github-issue-approval", () => githubIssueApprovalItems(db))],
    ["design-plan-approval", () => pendingPlans(db).map((plan) => ({
      source_kind: "design-plan-approval" as const,
      source_key: `design-plan-approval:${plan.id}`,
      summary: `Design plan v${plan.version}: ${plan.title}`,
      raised_at: plan.raisedAt,
      session_id: plan.sessionId ?? null,
      project: plan.sessionId ? ports.projectOf(plan.sessionId) : null,
      link: ports.webUrl("/inbox"),
    }))],
    ["human-wait", () => (db.prepare("SELECT id, metadata FROM sessions WHERE status = 'active'").all() as Array<{ id: string; metadata: string | null }>)
      .flatMap((row) => {
        const wait = readHumanWait(row.metadata);
        return wait ? [{
          source_kind: "human-wait" as const, source_key: `human-wait:${row.id}:${wait.since}`,
          summary: `人間待ち: ${wait.summary}`, human_action: normalizeHumanAction(wait.human_action),
          raised_at: wait.since < 1e12 ? wait.since * 1000 : wait.since,
          session_id: row.id, project: ports.projectOf(row.id), link: ports.webUrl(`/sessions/${row.id}`),
        }] : [];
      })],
    ["management-waiting-human", () => (db.prepare(
      "SELECT id, kind, project_code, purpose, session_id, updated_at FROM management_requests WHERE state = 'waiting_human' ORDER BY updated_at ASC",
    ).all() as Array<{ id: string; kind: string; project_code: string; purpose: string; session_id: string | null; updated_at: number }>)
      .map((row) => ({
        source_kind: "management-waiting-human" as const, source_key: `management:${row.id}`,
        summary: `CDGD ${row.kind} の人間判断待ち: ${row.purpose}`, raised_at: row.updated_at,
        session_id: row.session_id, project: row.project_code, link: ports.webUrl("/management"),
      }))],
    ["session-unresponsive", () => (db.prepare(
      "SELECT session_id, project, status_reason, classified_at FROM control_progress_board WHERE status = 'unresponsive'",
    ).all() as Array<{ session_id: string; project: string; status_reason: string | null; classified_at: number | null }>)
      .map((row) => ({
        source_kind: "session-unresponsive" as const, source_key: `unresponsive:${row.session_id}`,
        summary: `応答なし: ${row.status_reason ?? "追加指示に反応がありません"}`,
        // 進捗ボードの時刻は秒 (実装メモ 5)。
        raised_at: (row.classified_at ?? 0) * 1000,
        session_id: row.session_id, project: row.project, link: ports.webUrl(`/sessions/${row.session_id}`),
      }))],
  ];
  if (ports.deskIssues) {
    const readIssues = ports.deskIssues;
    for (const kind of ["desk-project-selection", "desk-routing-issue"] as const) {
      readers.push([kind, () => readIssues()
        .filter((row) => (kind === "desk-project-selection") === (row.routing_issue === "project"))
        .map((row) => ({
          source_kind: kind, source_key: `desk:${row.id}`, session_id: null,
          summary: row.error ?? "依頼の状況を確認する", project: row.project_code ?? null,
          raised_at: row.created_at, link: ports.webUrl(`/desk?request=${encodeURIComponent(row.id)}`),
        }))]);
    }
  }

  return {
    read(): SourceReading[] {
      return readers.map(([kind, read]): SourceReading => {
        try {
          return { kind, readable: true, items: read() };
        } catch (error) {
          return { kind, readable: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    },
  };
}

export type CardSources = ReturnType<typeof createCardSources>;
