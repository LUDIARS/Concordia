/**
 * src/discord/domain-review-embeds.ts — ドメインレビューのレポート → embed。
 *
 * 「Anatomia の画面を開かずにレビューできる」ことが目的なので、 載せるのは
 * **人がその場で判断できる材料**に絞る: コアドメインの名前と説明、 親子と関係辺、
 * 層ごとのプログラムドメイン、 層違反依存、 そして plan の問い。
 * 指標 (凝集度など) は判断を助けないので出さない。
 *
 * 上限と切り詰め、 メンション無害化は embed-limits.ts に閉じている。
 *
 * SRP: 何をどの順で載せるか。 送信は domain-review-post.ts。
 *
 * @implements spec/feature/domain-review-discord.md §2.3, §2.5
 */

import type { DomainReviewReport, DomainReviewTrigger } from "../domain-review/types.js";
import { clampLines, clampText, fitEmbeds, EMBED_LIMITS, type EmbedSpec } from "./embed-limits.js";

const COLOR_CORE = 0x5865f2;
const COLOR_PROGRAM = 0x57f287;
const COLOR_PLAN = 0xf0b232;

const TRIGGER_LABEL: Record<DomainReviewTrigger, string> = {
  plan: "anatomia plan 生成",
  "local-pr": "Revisor local PR 提出",
  manual: "/domain-review",
};

/**
 * 投稿 1 通ぶんの embed。 必ず Discord の上限内に収まる
 * (`fitEmbeds` を通してから返すのがこの関数の約束)。
 */
export function buildDomainReviewEmbeds(report: DomainReviewReport): EmbedSpec[] {
  // fitEmbeds は合計 6000 文字を超えると後ろから落とす。plan 投稿では、返信先となる
  // 問い自体が消えると回答を求める投稿として成立しないため、問いを最優先に残す。
  const embeds: EmbedSpec[] = report.planQuestions.length > 0
    ? [planEmbed(report), coreEmbed(report), programEmbed(report)]
    : [coreEmbed(report), programEmbed(report)];
  return fitEmbeds(embeds);
}

function coreEmbed(report: DomainReviewReport): EmbedSpec {
  const uxCritical = report.coreDomains.filter((domain) => domain.uxCritical);
  const fields = [
    {
      name: `コアドメイン (${report.coreDomains.length})`,
      value: clampLines(report.coreDomains.map(coreDomainLine)),
    },
  ];
  if (uxCritical.length > 0) {
    fields.push({
      name: `UX 直結 (${uxCritical.length}) — レビューとテストを厚く`,
      value: clampLines(uxCritical.map((domain) => `\`${domain.name}\``)),
    });
  }
  const hierarchy = report.coreDomains
    .filter((domain) => domain.parentId)
    .map((domain) => `\`${domain.name}\` ⊂ \`${domain.parentId}\``);
  if (hierarchy.length > 0) {
    fields.push({ name: `親子 (${hierarchy.length})`, value: clampLines(hierarchy) });
  }
  fields.push({
    name: `関係辺 (${report.relations.length})`,
    value: report.relations.length === 0
      ? "(承認済みの関係辺なし)"
      : clampLines(report.relations.map(relationLine)),
  });

  return {
    title: `📑 [${report.target.code}] ${report.target.project} — コアドメイン`,
    description: clampText(describeHeader(report), EMBED_LIMITS.description),
    color: COLOR_CORE,
    fields,
    footer: { text: `出所: Anatomia (${report.anatomiaProjectId}) / 契機: ${TRIGGER_LABEL[report.trigger]}` },
  };
}

function programEmbed(report: DomainReviewReport): EmbedSpec {
  const fields = report.layers.length === 0
    ? [{ name: "層", value: "(層情報がありません)" }]
    : report.layers.map((layer) => ({
      name: `${layer.layer} (${layer.domains.length})`,
      value: clampLines(layer.domains.map((domain) =>
        domain.misfitCount > 0 ? `\`${domain.id}\` ⚠${domain.misfitCount}` : `\`${domain.id}\``)),
    }));

  fields.push({
    name: `層違反依存 (${report.layerViolations.length})`,
    value: report.layerViolations.length === 0
      ? "なし"
      : clampLines(report.layerViolations
        .map((violation) => `\`${violation.from}\` → \`${violation.to}\` (${violation.weight})`)),
  });
  if (report.unlinkedProgramDomains.length > 0) {
    fields.push({
      name: `コアドメイン未所属 (${report.unlinkedProgramDomains.length})`,
      value: clampLines(report.unlinkedProgramDomains.map((id) => `\`${id}\``)),
    });
  }
  if (report.unclassifiedModules.length > 0) {
    fields.push({
      name: `層未分類 (${report.unclassifiedModules.length})`,
      value: clampLines(report.unclassifiedModules.map((id) => `\`${id}\``)),
    });
  }

  return {
    title: `🧱 [${report.target.code}] プログラムドメイン (層)`,
    color: COLOR_PROGRAM,
    fields,
  };
}

function planEmbed(report: DomainReviewReport): EmbedSpec {
  return {
    title: "❓ plan の要レビュー事項",
    description: "この投稿に返信すると、回答が plan の突合資料に追記されます。",
    color: COLOR_PLAN,
    fields: [{
      name: `問い (${report.planQuestions.length})`,
      value: clampLines(report.planQuestions.map((question, index) => `${index + 1}. ${question}`)),
    }],
    ...(report.planTaskHash ? { footer: { text: `plan ${report.planTaskHash}` } } : {}),
  };
}

function coreDomainLine(domain: DomainReviewReport["coreDomains"][number]): string {
  const marks = [
    domain.uxCritical ? "🎯" : "",
    domain.status === "missing" ? "⚠未実装" : "",
    domain.status === "drifted" ? "⚠逸脱" : "",
  ].filter(Boolean).join("");
  const counts = domain.implementorCount === null
    ? ""
    : ` (実装 ${domain.implementorCount}`
      + `${domain.violationCount ? ` / 逸脱 ${domain.violationCount}` : ""})`;
  const purpose = domain.purpose ? ` — ${firstLine(domain.purpose)}` : "";
  return `\`${domain.name}\`${marks}${counts}${purpose}`;
}

function relationLine(relation: DomainReviewReport["relations"][number]): string {
  const rationale = relation.rationale ? ` — ${firstLine(relation.rationale)}` : "";
  return `\`${relation.from}\` –${relation.relation}→ \`${relation.to}\`${rationale}`;
}

function describeHeader(report: DomainReviewReport): string {
  const lines = [
    report.source === "prepared"
      ? "Anatomia の web-cache (prepared) から取得。"
      : "**未 prepare のため生データで代替しています。**",
    ...report.notes,
  ];
  return lines.join("\n");
}

/** 説明文は 1 行目だけを出す (embed の行数を説明の長さで振り回されない)。 */
function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? "";
  return clampText(line.trim(), 160);
}
