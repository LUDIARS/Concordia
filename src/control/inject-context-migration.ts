import { createHash } from "node:crypto";
import { LEGACY_DOMAIN_REPORT } from "./major-inject-catalog.js";

const revisions: Readonly<Record<string, string>> = {
  "session.work_policy": "0c268c6ad20d35127d4162d564dfce08b00398bc5ad09cc903e71cf43c74f178",
  "session.workflow.normal": "73602ef5203e113d493828802d4d876489e2f4d6aab88cb7881ee1fb32929911",
  "session.process_guidance": "1d94742703f5c29987c3a901ef973eaf37616ec477ac6528b3b2ce126f92c991",
  "delegation.persona_context": "d0924942081a0ab76a5358030247e0211844561ff6def4ce629cda1e0e06d577",
};

const workPolicySuffix = "\n\nPf 仕様と An の domain/関数 map は現行 registry/catalog で実体と URL を解決できたときだけリンクし、未登録・未確認ならそう明記して repo spec を示してください。\nURL を推測しないでください。";
const processHeader = "[Cc DDD/契約プロセス] 必須設定が有効です。人間の指示に対応する Actio task と実装 domain を確認してください。";
const genericHeader = "[Cc 必須プロセス] 必須設定が有効です。人間の指示に対応する Actio task を確認してください。";
const personaAnatomiaBlock = "- コードの配置・既存実装・影響範囲は **Anatomia の解析グラフ**から引きます\n  (`/anatomia-analyze` の supply → CLI の `find` / `where` / `context`)。 事前の調査報告は要りません。";
const personaGenericLine = "- コードの配置・既存実装・影響範囲は、対象リポジトリの設計資料と実コードから調べます。事前の調査報告は要りません。";

export function stripKnownPersonaFragment(content: string): string | null {
  const suffix = `\n${LEGACY_DOMAIN_REPORT}`;
  if (!content.endsWith(suffix)) return null;
  const withoutReport = content.slice(0, -suffix.length);
  const index = withoutReport.indexOf(personaAnatomiaBlock);
  if (index < 0 || withoutReport.indexOf(personaAnatomiaBlock, index + personaAnatomiaBlock.length) >= 0) return null;
  return withoutReport.slice(0, index) + personaGenericLine + withoutReport.slice(index + personaAnatomiaBlock.length);
}

/** Only four observed revisions and byte-exact legacy fragments may be migrated. */
export function migrateKnownContextFragment(id: string, content: string): string | null {
  const expected = revisions[id];
  if (!expected || createHash("sha256").update(content).digest("hex") !== expected) return null;
  if (id === "session.work_policy") return content.endsWith(workPolicySuffix) ? content.slice(0, -workPolicySuffix.length) : null;
  if (id === "session.process_guidance") {
    const suffix = `\n${LEGACY_DOMAIN_REPORT}`;
    return content.startsWith(processHeader) && content.endsWith(suffix)
      ? genericHeader + content.slice(processHeader.length, -suffix.length) : null;
  }
  if (id === "delegation.persona_context") return stripKnownPersonaFragment(content);
  const suffix = `\n${LEGACY_DOMAIN_REPORT}`;
  return content.endsWith(suffix) ? content.slice(0, -suffix.length) : null;
}
