/**
 * 相談ログ (spec/feature/tech-consultation.md §6.2) を相談者のデータフォルダへ追記する application service。
 *
 * - 相談のセッション (プロジェクトを持たない相談部署、 作業フォルダが相談の置き場所の中) だけを書く。
 * - 発言ごとに追記する (落ちても途中まで残る)。 最初の 1 件の前に見出しと事前ヒアリングを書く。
 * - 終了 (session.ended / session.lost) で終了時刻と理由を書く。
 * - 書き込みの失敗は warn ログだけで、 相談は止めない。 ログ本文は warn に出さない (CC-CONSULT-INV-05)。
 *
 * 置き場所はデータフォルダの中なので、 claudeMdExcludes (CC-CONSULT-INV-08) の対象で相談セッションに指示として読まれない。
 *
 * @implements SPEC-CONSULT-LOG
 */

import { basename, resolve, sep } from "node:path";
import type { ConcordiaEvent } from "../events.js";
import { readEndSessionRequestedAt } from "../shared/end-session-request.js";
import {
  classifyConsultLogMessage,
  consultLogFilePath,
  renderConsultLogEntry,
  renderConsultLogFooter,
  renderConsultLogHeader,
  type ConsultLogIntake,
  type ConsultLogMessage,
} from "./consult-log-markdown.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:f3b91c33 */
import augurContract_f3e62cc9 from './consult-log-writer.contract.js'; /* augur-inject:contract-predicate:6d0182bb */

export interface ConsultLogSession {
  id: string;
  repo_path: string;
  /** 開始時刻 (秒)。 */
  started_at: number;
  metadata: string | null;
  department_id?: string | null;
}

export interface ConsultLogTargetInput {
  session: ConsultLogSession;
  /** セッションの部署がプロジェクトを持たない相談部署か。 */
  isConsultDepartment: boolean;
  /** 相談の作業ディレクトリの置き場所 (CONCORDIA_CONSULT_WORKSPACE_ROOT)。 */
  workspaceRoot: string | undefined;
}

export interface ConsultLogTarget {
  filePath: string;
  roleFolder: string;
  model: string | null;
  startedAtMs: number;
}

function metadataText(metadata: string | null, key: string): string | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function isInside(root: string, path: string): boolean {
  const base = resolve(root).toLowerCase();
  const target = resolve(path).toLowerCase();
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** 相談ログの書き先。 相談のセッションでない・作業フォルダが置き場所の外なら null (プロジェクトのリポへは書かない)。 */
export function resolveConsultLogTarget(input: ConsultLogTargetInput): ConsultLogTarget | null {
  const root = input.workspaceRoot?.trim();
  if (!input.isConsultDepartment || !root) return null;
  const roleWorkspace = input.session.repo_path?.trim();
  if (!roleWorkspace || !isInside(root, roleWorkspace)) return null;
  const startedAtMs = toMs(input.session.started_at);
  return {
    filePath: consultLogFilePath({
      roleWorkspace,
      requesterDiscordUserId: metadataText(input.session.metadata, "discord_requester_user_id"),
      sessionId: input.session.id,
      startedAtMs,
    }),
    roleFolder: basename(resolve(roleWorkspace)),
    model: metadataText(input.session.metadata, "model"),
    startedAtMs,
  };
}
// @ts-expect-error augur-inject
resolveConsultLogTarget = contract(resolveConsultLogTarget, { ...augurContract_f3e62cc9, contractId: 'consult-log-C-5', mode: 'observe', sample: 1, where: 'src/consultation/consult-log-writer.ts:68', rule: 'contract-wrap', id: 'f3e62cc9' }); /* augur-inject:contract-wrap:f3e62cc9 */

/** event の時刻は秒、 一部 ms のことがあるので ms へ揃える。 */
function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export interface ConsultLogWriterPorts {
  findSession(sessionId: string): ConsultLogSession | null;
  isConsultDepartment(departmentId: string): boolean;
  departmentName(departmentId: string): string | null;
  /** 事前ヒアリング (受付チャンネルの最新)。 無ければ null。 */
  intake(session: ConsultLogSession): ConsultLogIntake | null;
  workspaceRoot: string | undefined;
  fileExists(path: string): Promise<boolean>;
  /** 追記する (フォルダが無ければ作る)。 */
  append(path: string, text: string): Promise<void>;
  log: { warn(message: string): void };
}

export interface ConsultLogMessageInput extends ConsultLogMessage {
  id: number;
  ts: number;
  content: string;
}

export class ConsultLogWriter {
  private readonly targets = new Map<string, ConsultLogTarget | null>();
  private readonly written = new Map<string, Set<number>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly ports: ConsultLogWriterPorts) {}

  /** 相談者の発言・最終回答を 1 件追記する。 同じ発言は 1 回だけ (編集で届き直しても書かない)。 */
  recordMessage(sessionId: string, message: ConsultLogMessageInput): Promise<void> {
    const kind = classifyConsultLogMessage(message);
    if (!kind || !message.content.trim()) return Promise.resolve();
    const seen = this.written.get(sessionId) ?? new Set<number>();
    if (seen.has(message.id)) return Promise.resolve();
    seen.add(message.id);
    this.written.set(sessionId, seen);
    return this.enqueue(sessionId, async (target, session) => {
      await this.ensureHeader(target, session);
      await this.ports.append(target.filePath, renderConsultLogEntry(kind, toMs(message.ts), message.content));
    });
  }

  /** 終了時刻と理由を書き、 このセッションの記憶を捨てる。 */
  recordEnd(sessionId: string, atTs: number, reason: string): Promise<void> {
    const done = this.enqueue(sessionId, async (target, session) => {
      await this.ensureHeader(target, session);
      await this.ports.append(target.filePath, renderConsultLogFooter(toMs(atTs), reason));
    });
    return done.finally(() => {
      this.targets.delete(sessionId);
      this.written.delete(sessionId);
      this.queues.delete(sessionId);
    });
  }

  /** eventBus の購読口。 発言は作成・更新のどちらで届いても最初の 1 回だけ書く (最終回答は更新で印が付くことがある)。 */
  handleEvent(event: ConcordiaEvent): void {
    if (event.type === "session.message") {
      void this.recordMessage(event.target_session_id, event.message);
    } else if (event.type === "session.ended") {
      const metadata = this.ports.findSession(event.session_id)?.metadata ?? null;
      const spoken = readEndSessionRequestedAt(metadata) !== null;
      void this.recordEnd(event.session_id, event.ts, spoken ? "終了の指示 (発言)" : "セッションの終了");
    } else if (event.type === "session.lost") {
      void this.recordEnd(event.session_id, event.ts, "セッションの消失");
    }
  }

  private resolveTarget(sessionId: string): { target: ConsultLogTarget; session: ConsultLogSession } | null {
    const session = this.ports.findSession(sessionId);
    if (!session) return null;
    if (!this.targets.has(sessionId)) {
      const departmentId = session.department_id ?? null;
      this.targets.set(sessionId, resolveConsultLogTarget({
        session,
        isConsultDepartment: departmentId !== null && this.ports.isConsultDepartment(departmentId),
        workspaceRoot: this.ports.workspaceRoot,
      }));
    }
    const target = this.targets.get(sessionId);
    return target ? { target, session } : null;
  }

  private async ensureHeader(target: ConsultLogTarget, session: ConsultLogSession): Promise<void> {
    if (await this.ports.fileExists(target.filePath)) return;
    const departmentId = session.department_id ?? null;
    await this.ports.append(target.filePath, renderConsultLogHeader({
      sessionId: session.id,
      startedAtMs: target.startedAtMs,
      departmentName: departmentId ? this.ports.departmentName(departmentId) : null,
      roleFolder: target.roleFolder,
      model: target.model,
      intake: this.ports.intake(session),
    }));
  }

  /** セッションごとに順に書く (見出しの二重書きと順序の入れ替わりを防ぐ)。 失敗は warn だけ。 */
  private enqueue(
    sessionId: string,
    write: (target: ConsultLogTarget, session: ConsultLogSession) => Promise<void>,
  ): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      let resolved: ReturnType<ConsultLogWriter["resolveTarget"]>;
      try {
        resolved = this.resolveTarget(sessionId);
      } catch (error) {
        this.ports.log.warn(`consult-log: resolve failed session=${sessionId}: ${(error as Error).message}`);
        return;
      }
      if (!resolved) return;
      try {
        await write(resolved.target, resolved.session);
      } catch (error) {
        this.ports.log.warn(`consult-log: write failed session=${sessionId}: ${(error as Error).message}`);
      }
    });
    this.queues.set(sessionId, next);
    return next;
  }
}
