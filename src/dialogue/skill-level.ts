/**
 * 相談者の技術レベルに合わせた説明の仕方 (spec/feature/tech-consultation.md §3、 2026-10-02 neco 指示)。
 *
 * - 初級: 小学五年生でわかるように話す。 専門用語は使わない。
 * - 中級: 専門用語は使ってよいが、 シニアクラスの話は噛み砕いて説明する。
 * - 上級: シニアクラスとして扱う。
 *
 * 入力は自由記述 (「初級」や「経験 3 年」)。 3 段階の語が読めればその段階の指示だけを返し、
 * 読めなければ 3 段階の定義を並べてセッションに当てはめさせる。
 *
 * @implements SPEC-CONSULT-INTAKE
 */

export type SkillTier = "beginner" | "intermediate" | "advanced";

const GUIDANCE: Readonly<Record<SkillTier, string>> = {
  beginner: "初級: 小学五年生でわかるように話す。専門用語は使わない (どうしても要る言葉は身近なたとえで言い換える)。",
  intermediate: "中級: 専門用語は使ってよい。シニアクラスの話は噛み砕いて説明する。",
  advanced: "上級: シニアクラスとして扱う。基礎の説明は省き、判断の根拠とトレードオフを中心に話す。",
};

const TIER_ORDER: readonly SkillTier[] = ["beginner", "intermediate", "advanced"];

/** 自由記述から 3 段階を読む。 複数の段階の語が混ざる・どれも無いときは null。 */
export function parseSkillTier(text: string): SkillTier | null {
  const value = text.trim();
  const hits = new Set<SkillTier>();
  if (/初級|初心|ビギナー|beginner|入門/i.test(value)) hits.add("beginner");
  if (/中級|intermediate/i.test(value)) hits.add("intermediate");
  if (/上級|シニア|senior|advanced|エキスパート|expert/i.test(value)) hits.add("advanced");
  return hits.size === 1 ? [...hits][0]! : null;
}

/** 起動時の前提に入れる「説明の仕方」の行。 */
export function skillLevelGuidance(skillLevel: string): string[] {
  const tier = parseSkillTier(skillLevel);
  if (tier) return [`- 説明の仕方: ${GUIDANCE[tier]}`];
  return [
    "- 説明の仕方: 技術レベルの記述から、次の 3 段階のどれに当たるかを判断して合わせる。",
    ...TIER_ORDER.map((t) => `  - ${GUIDANCE[t]}`),
  ];
}
