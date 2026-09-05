/**
 * src/domain-review/report.ts — Anatomia の応答 → 投稿用レポート。
 *
 * Anatomia のペイロードは **信頼できない外部入力として扱う**。 形が違えば黙って
 * 落とし、 型が合うものだけを写す — 投稿経路の途中で例外を投げると、
 * 「ドメイン情報が出ない」ではなく「PR 提出が失敗する」になってしまう。
 *
 * SRP: 形の変換だけ。 HTTP も描画も持たない (どちらも純関数の外)。
 *
 * @implements spec/feature/domain-review-discord.md §2.3
 */

import type { AnatomiaRawDomain } from "./anatomia-client.js";
import type {
  DomainReviewCoreDomain,
  DomainReviewLayer,
  DomainReviewLayerViolation,
  DomainReviewRelation,
  DomainReviewReport,
  DomainReviewTarget,
  DomainReviewTrigger,
} from "./types.js";

/** plan からレポートへ持ち込む部分だけ。 plan 全体には依存しない。 */
export interface DomainReviewPlanInput {
  taskHash: string;
  questions: string[];
  /** 紐付け不能だった責務。 questions と並べて出す。 */
  unresolved: Array<{ subject: string; reason: string }>;
}

export interface BuildDomainReviewReportInput {
  target: DomainReviewTarget;
  trigger: DomainReviewTrigger;
  anatomiaProjectId: string;
  /** 取れなかったときは null。 */
  businessView: unknown;
  programView: unknown;
  /** prepared が無いときのフォールバック源。 */
  rawDomains: readonly AnatomiaRawDomain[] | null;
  plan: DomainReviewPlanInput | null;
  /** 未 prepare など、読み手に伝える但し書き。 */
  notes?: readonly string[];
}

/**
 * 投稿 1 回分のレポートを組む。 prepared が読めればそちらを、 読めなければ
 * 生データを使う。 **どちらも無ければ null** — 投稿する中身が無いということ。
 */
export function buildDomainReviewReport(input: BuildDomainReviewReportInput): DomainReviewReport | null {
  const notes = [...(input.notes ?? [])];
  const business = readBusinessView(input.businessView);
  const program = readProgramView(input.programView);
  const prepared = business !== null || program !== null;

  const coreDomains = business?.domains ?? rawCoreDomains(input.rawDomains);
  const hasPlanMaterial = (input.plan?.questions.length ?? 0) > 0
    || (input.plan?.unresolved.length ?? 0) > 0;
  if (coreDomains.length === 0 && (program?.layers.length ?? 0) === 0 && !hasPlanMaterial) return null;

  return {
    target: input.target,
    trigger: input.trigger,
    source: prepared ? "prepared" : "raw",
    anatomiaProjectId: input.anatomiaProjectId,
    coreDomains,
    relations: business?.relations ?? [],
    unlinkedProgramDomains: business?.unlinkedProgramDomains ?? [],
    layers: program?.layers ?? [],
    layerViolations: program?.violations ?? [],
    unclassifiedModules: program?.unclassified ?? [],
    planQuestions: [
      ...(input.plan?.questions ?? []),
      ...(input.plan?.unresolved ?? []).map((entry) => `${entry.subject} — ${entry.reason}`),
    ],
    planTaskHash: input.plan?.taskHash ?? null,
    notes,
  };
}

interface BusinessViewSlice {
  domains: DomainReviewCoreDomain[];
  relations: DomainReviewRelation[];
  unlinkedProgramDomains: string[];
}

function readBusinessView(value: unknown): BusinessViewSlice | null {
  if (!isRecord(value) || !Array.isArray(value["domains"])) return null;
  const domains = value["domains"].flatMap((entry): DomainReviewCoreDomain[] => {
    if (!isRecord(entry)) return [];
    const id = str(entry["id"]);
    const name = str(entry["name"]) || id;
    if (!id && !name) return [];
    return [{
      id: id || name,
      name: name || id,
      purpose: str(entry["purpose"]),
      status: str(entry["status"]) || "unknown",
      uxCritical: entry["uxCritical"] === true,
      parentId: typeof entry["parentId"] === "string" ? entry["parentId"] : null,
      childIds: strArray(entry["childIds"]),
      implementorCount: null,
      violationCount: null,
    }];
  });
  const relations = Array.isArray(value["relations"])
    ? value["relations"].flatMap((entry): DomainReviewRelation[] => {
      if (!isRecord(entry)) return [];
      const from = str(entry["from"]);
      const to = str(entry["to"]);
      if (!from || !to) return [];
      return [{ from, to, relation: str(entry["relation"]) || "relates", rationale: str(entry["rationale"]) }];
    })
    : [];
  const unlinked = Array.isArray(value["unlinkedProgramDomains"])
    ? value["unlinkedProgramDomains"].flatMap((entry) =>
      isRecord(entry) && typeof entry["programDomainId"] === "string" ? [entry["programDomainId"]] : [])
    : [];
  return { domains, relations, unlinkedProgramDomains: unlinked };
}

interface ProgramViewSlice {
  layers: DomainReviewLayer[];
  violations: DomainReviewLayerViolation[];
  unclassified: string[];
}

function readProgramView(value: unknown): ProgramViewSlice | null {
  if (!isRecord(value) || !Array.isArray(value["layers"])) return null;
  const layers = value["layers"].flatMap((entry): DomainReviewLayer[] => {
    if (!isRecord(entry)) return [];
    const layer = str(entry["layer"]);
    if (!layer) return [];
    const domains = Array.isArray(entry["domains"])
      ? entry["domains"].flatMap((domain) => {
        if (!isRecord(domain)) return [];
        const id = str(domain["id"]);
        if (!id) return [];
        return [{
          id,
          cohesion: typeof domain["cohesion"] === "number" ? domain["cohesion"] : null,
          misfitCount: typeof domain["misfitCount"] === "number" ? domain["misfitCount"] : 0,
        }];
      })
      : [];
    return [{ layer, domains }];
  });
  const violations = Array.isArray(value["dependencies"])
    ? value["dependencies"].flatMap((entry): DomainReviewLayerViolation[] => {
      if (!isRecord(entry) || entry["layerViolation"] !== true) return [];
      const from = str(entry["from"]);
      const to = str(entry["to"]);
      if (!from || !to) return [];
      return [{ from, to, weight: typeof entry["weight"] === "number" ? entry["weight"] : 0 }];
    })
    : [];
  const unclassified = Array.isArray(value["diagnostics"])
    ? value["diagnostics"].flatMap((entry) =>
      isRecord(entry) && entry["kind"] === "unclassified" && typeof entry["moduleId"] === "string"
        ? [entry["moduleId"]]
        : [])
    : [];
  return { layers, violations, unclassified };
}

/**
 * 未 prepare 時のコアドメイン。 説明も階層も無いが、 **名前と実装数と逸脱数**は
 * 出せる — それだけでも「宣言したドメインが実装を持っていない」は読み取れる。
 */
function rawCoreDomains(rows: readonly AnatomiaRawDomain[] | null): DomainReviewCoreDomain[] {
  return (rows ?? []).map((row) => ({
    id: row.domain,
    name: row.domain,
    purpose: "",
    status: row.conforms ? "declared" : "drifted",
    uxCritical: false,
    parentId: null,
    childIds: [],
    implementorCount: row.implementorCount,
    violationCount: row.violationCount,
  }));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
