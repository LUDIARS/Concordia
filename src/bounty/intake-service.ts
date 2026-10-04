/**
 * バグ報告の受付 use case (spec/feature/bug-bounty.md §3 §4 §9)。
 *
 * Discord・セッション・Cocoiru のどの受付口も `submit` を通る。 権限 (有効なセッション / 会社の範囲) を
 * 確かめ、 台帳へ書いてから応答する (CC-BOUNTY-INV-03)。 受付は外部 (Actio・Revisor・AI) を呼ばない。
 * 同じ冪等キーの再送は何も書かず同じ報告を返す (CC-BOUNTY-INV-02)。
 *
 * 判断は純関数 (intake.ts / project-scope.ts / reporter.ts / report-state.ts)、 保存は store の port。
 * 原文は台帳にだけ置き、 結果 (receipt) にもログにも含めない (§10)。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-REPORTER
 */

import type {
  BountyReportCreateInput,
  BountyReportEventInput,
  BountyReportPatch,
  BountyReportRow,
} from "../db/bounty-reports-repo.js";
import type { BountyReporterKey, BountyReporterRow } from "../db/bounty-reporters-repo.js";
import {
  MAX_BOUNTY_TEXT_CHARS,
  bountyIntakeKey,
  initialBountyStatus,
  missingBountyIntakeFields,
  normalizeBountyIntake,
  type BountyIntakeMissingField,
  type BountyIntakePlatform,
} from "./intake.js";
import { checkBountyReportProject, type BountyProject } from "./project-scope.js";
import {
  decideBountyWithdrawal,
  displayPublicName,
  normalizePublicName,
  resolveSessionRecipient,
  type BountyReporterIdentity,
} from "./reporter.js";
import { decideBountyTransition, type BountyReportStatus } from "./report-state.js";

export interface BountyReportStore {
  create(
    input: BountyReportCreateInput,
    event: Omit<BountyReportEventInput, "kind" | "from_value" | "to_value">,
    now?: number,
  ): { row: BountyReportRow; created: boolean };
  find(id: string): BountyReportRow | null;
  findByIntakeKey(intakeKey: string): BountyReportRow | null;
  transition(input: {
    id: string;
    from: BountyReportStatus;
    to: BountyReportStatus;
    patch?: BountyReportPatch;
    event: Omit<BountyReportEventInput, "from_value" | "to_value">;
  }, now?: number): boolean;
}

export interface BountyReporterStore {
  find(id: string): BountyReporterRow | null;
  findByKey(key: BountyReporterKey): BountyReporterRow | null;
  findOrCreate(key: BountyReporterKey, now?: number): BountyReporterRow;
  setPublicName(key: BountyReporterKey, publicName: string | null, now?: number): BountyReporterRow;
}

/** 報告できるセッションの見え方。 所属会社と依頼者は session metadata から adapter が読む。 */
export interface BountySessionView {
  id: string;
  /** 終了・消失していないか。 */
  active: boolean;
  /** 所属会社。 本社は null。 */
  companyId: string | null;
  requesterDiscordUserId: string | null;
}

export interface BountyIntakeDeps {
  reports: BountyReportStore;
  reporters: BountyReporterStore;
  /** project registry の登録。 */
  projects(): ReadonlyArray<BountyProject>;
  /** 会社 (子会社) の関係プロジェクト。 会社が無ければ null。 */
  companyProjects(companyId: string): readonly string[] | null;
  session(sessionId: string): BountySessionView | null;
  now?: () => number;
}

/** 報告を出す主体。 セッション自身か、 Bot / Cocoiru が渡す操作者 (人)。 */
export type BountyActor =
  | { kind: "session"; sessionId: string }
  | { kind: "operator"; platform: Exclude<BountyIntakePlatform, "session">; companyId: string | null; platformUserId: string };

export interface BountySubmitInput {
  actor: BountyActor;
  /** 冪等キーの素。 Discord は interaction id、 Cocoiru は Cocoiru の報告 id、 セッションは任意。 */
  clientKey: string | null;
  project: string | null;
  whatHappened: string;
  reproSteps: string;
  /** 人の報告だけが使う。 null / 未指定は公開名を変えない。 */
  publicName?: string | null;
  /** 結果を返す先 (Discord のチャンネル、 Cocoiru の通知先)。 セッションは session id を記録する。 */
  replyTo?: Record<string, string>;
}

export type BountyIntakeError =
  | "invalid_session"
  | "unknown_company"
  | "client_key_required"
  | "text_too_long"
  | "unknown_project"
  | "project_outside_company_scope"
  | "public_name_invalid"
  | "report_not_found"
  | "not_reporter"
  | "already_decided"
  | "not_awaiting_info"
  | "amendment_empty"
  | "state_changed";

/** 受付口へ返す内容。 原文を含めない。 */
export interface BountyReceipt {
  id: string;
  status: BountyReportStatus;
  project: string | null;
  missing: BountyIntakeMissingField[];
  /** 公開面・通知に出る報告者の名前。 */
  reporter: string;
  /** 報奨の受取人が居るか (居なければ報奨なし、 CC-BOUNTY-INV-05)。 */
  has_recipient: boolean;
}

export type BountySubmitResult =
  | { ok: true; created: boolean; receipt: BountyReceipt }
  | { ok: false; error: BountyIntakeError };

export type BountyChangeResult = { ok: true; receipt: BountyReceipt } | { ok: false; error: BountyIntakeError };

export type BountyPublicNameResult =
  | { ok: true; publicName: string | null; display: string }
  | { ok: false; error: BountyIntakeError };

interface ResolvedActor {
  companyId: string | null;
  platform: BountyIntakePlatform;
  /** 人の報告の本人。 セッションなら null。 */
  person: BountyReporterKey | null;
  /** 報奨の受取人。 特定できなければ null。 */
  recipient: BountyReporterKey | null;
  sessionId: string | null;
}

export class BountyIntakeService {
  private readonly now: () => number;

  constructor(private readonly deps: BountyIntakeDeps) {
    this.now = deps.now ?? Date.now;
  }

  submit(input: BountySubmitInput): BountySubmitResult {
    const actor = this.resolveActor(input.actor);
    if (!actor.ok) return actor;
    const fields = normalizeBountyIntake({
      project: input.project,
      what_happened: input.whatHappened,
      repro_steps: input.reproSteps,
    });
    if (fields.what_happened.length > MAX_BOUNTY_TEXT_CHARS || fields.repro_steps.length > MAX_BOUNTY_TEXT_CHARS) {
      return { ok: false, error: "text_too_long" };
    }
    const intakeKey = bountyIntakeKey({
      platform: actor.value.platform,
      clientKey: input.clientKey,
      sessionId: actor.value.sessionId,
      fields,
    });
    if (!intakeKey) return { ok: false, error: "client_key_required" };
    // 応答が失われた再送は、 何も書かず同じ報告を返す。 再送時の入力では台帳を変えない。
    const resent = this.deps.reports.findByIntakeKey(intakeKey);
    if (resent) return { ok: true, created: false, receipt: this.receiptOf(resent) };

    const project = checkBountyReportProject({
      code: fields.project,
      registered: this.deps.projects(),
      // 所属会社が登録から消えたセッションは、 本社扱い (制限なし) にせず範囲を空にする (fail closed)。
      companyProjects: actor.value.companyId === null ? null : this.deps.companyProjects(actor.value.companyId) ?? [],
    });
    if (!project.ok) return { ok: false, error: project.denial };
    const publicName = actor.value.person ? normalizePublicName(input.publicName) : null;
    if (publicName && !publicName.ok) return { ok: false, error: publicName.error };

    const now = this.now();
    const person = actor.value.person ? this.deps.reporters.findOrCreate(actor.value.person, now) : null;
    if (actor.value.person && publicName?.ok && publicName.name !== null) {
      this.deps.reporters.setPublicName(actor.value.person, publicName.name, now);
    }
    const recipient = actor.value.recipient ? this.deps.reporters.findOrCreate(actor.value.recipient, now) : null;
    const { row, created } = this.deps.reports.create({
      subsidiary_id: actor.value.companyId,
      project_code: project.project?.code ?? null,
      reporter_kind: person ? "person" : "session",
      reporter_id: person?.id ?? null,
      reporter_session_id: actor.value.sessionId,
      recipient_reporter_id: recipient?.id ?? null,
      what_happened: fields.what_happened,
      repro_steps: fields.repro_steps,
      intake_platform: actor.value.platform,
      intake_key: intakeKey,
      intake_ref_json: JSON.stringify(actor.value.sessionId
        ? { session_id: actor.value.sessionId }
        : input.replyTo ?? {}),
      status: initialBountyStatus(fields),
    }, { actor_kind: person ? "human" : "ai", actor_id: person?.id ?? actor.value.sessionId }, now);
    return { ok: true, created, receipt: this.receiptOf(row) };
  }

  /** 取り下げ。 採用前の報告者本人だけ (§9)。 */
  withdraw(input: { reportId: string; actor: BountyActor }): BountyChangeResult {
    const allowed = this.reporterOwnChange(input.reportId, input.actor, "withdrawn", "already_decided");
    if (!allowed.ok) return allowed;
    const now = this.now();
    const changed = this.deps.reports.transition({
      id: allowed.report.id,
      from: allowed.report.status,
      to: "withdrawn",
      patch: { withdrawn_at: now },
      event: { kind: "withdrawn", ...allowed.eventActor },
    }, now);
    return this.changed(allowed.report.id, changed);
  }

  /**
   * 追記。 情報不足 (needs_info) の報告へ報告者本人が書き足し、 仕分けへ戻す (§9)。
   * 書き足した本文は原文の後ろへ足す (元の報告を消さない)。
   */
  amend(input: { reportId: string; actor: BountyActor; whatHappened: string; reproSteps: string }): BountyChangeResult {
    const allowed = this.reporterOwnChange(input.reportId, input.actor, "received", "not_awaiting_info");
    if (!allowed.ok) return allowed;
    const added = normalizeBountyIntake({ what_happened: input.whatHappened, repro_steps: input.reproSteps });
    if (!added.what_happened && !added.repro_steps) return { ok: false, error: "amendment_empty" };
    const whatHappened = appendText(allowed.report.what_happened, added.what_happened);
    const reproSteps = appendText(allowed.report.repro_steps, added.repro_steps);
    if (whatHappened.length > MAX_BOUNTY_TEXT_CHARS || reproSteps.length > MAX_BOUNTY_TEXT_CHARS) {
      return { ok: false, error: "text_too_long" };
    }
    // 「何が起きたか」が埋まらない追記では仕分けへ戻せない。
    if (missingBountyIntakeFields({ what_happened: whatHappened }).length > 0) {
      return { ok: false, error: "amendment_empty" };
    }
    const changed = this.deps.reports.transition({
      id: allowed.report.id,
      from: allowed.report.status,
      to: "received",
      patch: { what_happened: whatHappened, repro_steps: reproSteps },
      event: { kind: "amended", ...allowed.eventActor },
    }, this.now());
    return this.changed(allowed.report.id, changed);
  }

  /** 公開名を変える。 変えられるのは本人の行だけ (操作者の組がそのまま行の鍵)。 */
  setPublicName(input: {
    companyId: string | null;
    platform: Exclude<BountyIntakePlatform, "session">;
    platformUserId: string;
    publicName: string | null;
  }): BountyPublicNameResult {
    if (input.companyId !== null && this.deps.companyProjects(input.companyId) === null) {
      return { ok: false, error: "unknown_company" };
    }
    const name = normalizePublicName(input.publicName);
    if (!name.ok) return { ok: false, error: name.error };
    const reporter = this.deps.reporters.setPublicName({
      subsidiary_id: input.companyId,
      platform: input.platform,
      platform_user_id: input.platformUserId,
    }, name.name, this.now());
    return {
      ok: true,
      publicName: reporter.public_name,
      display: displayPublicName({ kind: "person", publicName: reporter.public_name }),
    };
  }

  /** 受付口へ返す内容 (原文なし)。 */
  receiptOf(report: BountyReportRow): BountyReceipt {
    // セッションの報告は依頼者 (受取人) の公開名を添える。 人の報告は本人の公開名。
    const named = report.reporter_kind === "person" ? report.reporter_id : report.recipient_reporter_id;
    const publicName = named ? this.deps.reporters.find(named)?.public_name ?? null : null;
    return {
      id: report.id,
      status: report.status,
      project: report.project_code,
      missing: report.status === "needs_info" ? missingBountyIntakeFields(report) : [],
      reporter: displayPublicName({ kind: report.reporter_kind, publicName }),
      has_recipient: report.recipient_reporter_id !== null,
    };
  }

  /** 報告者本人による、 採用前の報告への変更 (取り下げ・追記) の可否。 */
  private reporterOwnChange(
    reportId: string,
    actorInput: BountyActor,
    to: BountyReportStatus,
    transitionError: BountyIntakeError,
  ):
    | { ok: true; report: BountyReportRow; eventActor: Pick<BountyReportEventInput, "actor_kind" | "actor_id"> }
    | { ok: false; error: BountyIntakeError } {
    const actor = this.resolveActor(actorInput);
    if (!actor.ok) return actor;
    const report = this.deps.reports.find(reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    const person = actor.value.person ? this.deps.reporters.findByKey(actor.value.person) : null;
    const identity: BountyReporterIdentity | null = actor.value.sessionId
      ? { kind: "session", sessionId: actor.value.sessionId }
      : person ? { kind: "person", reporterId: person.id } : null;
    // 台帳に行の無い人は、 どの報告の報告者でもない。
    if (!identity) return { ok: false, error: "not_reporter" };
    const decision = decideBountyWithdrawal({ status: report.status, reporter: reporterOf(report), actor: identity });
    if (!decision.ok) return { ok: false, error: decision.denial };
    if (!decideBountyTransition({ from: report.status, to }).ok) return { ok: false, error: transitionError };
    return {
      ok: true,
      report,
      eventActor: identity.kind === "session"
        ? { actor_kind: "ai", actor_id: identity.sessionId }
        : { actor_kind: "human", actor_id: identity.reporterId },
    };
  }

  private changed(reportId: string, changed: boolean): BountyChangeResult {
    // CAS に負けた = 判断の後に別の遷移 (仕分けの結果など) が入った。 上書きせず、 呼び出し側へ返す。
    if (!changed) return { ok: false, error: "state_changed" };
    return { ok: true, receipt: this.receiptOf(this.deps.reports.find(reportId)!) };
  }

  private resolveActor(actor: BountyActor): { ok: true; value: ResolvedActor } | { ok: false; error: BountyIntakeError } {
    if (actor.kind === "session") {
      const session = this.deps.session(actor.sessionId);
      if (!session || !session.active) return { ok: false, error: "invalid_session" };
      const recipient = resolveSessionRecipient({
        requesterDiscordUserId: session.requesterDiscordUserId,
        companyId: session.companyId,
      });
      return {
        ok: true,
        value: {
          companyId: session.companyId,
          platform: "session",
          person: null,
          recipient: recipient
            ? { subsidiary_id: recipient.companyId, platform: recipient.platform, platform_user_id: recipient.platformUserId }
            : null,
          sessionId: session.id,
        },
      };
    }
    if (actor.companyId !== null && this.deps.companyProjects(actor.companyId) === null) {
      return { ok: false, error: "unknown_company" };
    }
    const person: BountyReporterKey = {
      subsidiary_id: actor.companyId,
      platform: actor.platform,
      platform_user_id: actor.platformUserId,
    };
    return {
      ok: true,
      value: { companyId: actor.companyId, platform: actor.platform, person, recipient: person, sessionId: null },
    };
  }
}

function reporterOf(report: BountyReportRow): BountyReporterIdentity {
  return report.reporter_kind === "session"
    ? { kind: "session", sessionId: report.reporter_session_id ?? "" }
    : { kind: "person", reporterId: report.reporter_id ?? "" };
}

function appendText(current: string, added: string): string {
  if (!added) return current;
  return current ? `${current}\n\n[追記]\n${added}` : added;
}
