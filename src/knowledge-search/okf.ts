/**
 * ナレッジ検索の OKF (Open Knowledge Format) タグ (spec/feature/slack-knowledge-search.md KS-5)。
 *
 * 文書ごとに frontmatter 相当の値 (type 必須・title・domain・tags・roles) を持つ。
 * SRP: 値の正規化と検査だけ。 保存は tag-store.ts、 付与の手順は tagger.ts。
 */

import { z } from "zod";

export const OKF_TYPES = ["feature", "setup", "data", "interface", "test", "plan", "article", "note"] as const;
export type OkfType = (typeof OKF_TYPES)[number];

export interface OkfTags {
  type: OkfType;
  title: string;
  domain: string | null;
  tags: string[];
  roles: string[];
}

export const OKF_MAX_TAGS = 7;
export const OKF_MAX_ROLES = 5;

/** タグの表記ゆれを畳む (NFKC・小文字・空白は `-`、 先頭の `#` は落とす)。 空なら null。 */
export function normalizeTag(raw: string): string | null {
  const tag = raw.normalize("NFKC").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").slice(0, 40);
  return tag ? tag : null;
}

function uniqueTags(values: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const tag = normalizeTag(value);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** 値を検査して正規化する。 type が分類外なら note に寄せる。 */
export function makeOkfTags(input: { type?: string; title: string; domain?: string | null; tags?: readonly string[]; roles?: readonly string[] }): OkfTags {
  const type = (OKF_TYPES as readonly string[]).includes(input.type ?? "") ? (input.type as OkfType) : "note";
  return {
    type,
    title: input.title.trim().slice(0, 200),
    domain: input.domain ? normalizeTag(input.domain) : null,
    tags: uniqueTags(input.tags ?? [], OKF_MAX_TAGS),
    roles: (input.roles ?? []).map((r) => r.trim()).filter(Boolean).filter((r, i, a) => a.indexOf(r) === i).slice(0, OKF_MAX_ROLES),
  };
}

const LlmOkf = z.object({
  type: z.string().optional(),
  domain: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
});

/** LLM が返した JSON (前後の文やコードフェンスを含みうる) から OKF タグを読む。 読めなければ null。 */
export function parseLlmOkf(stdout: string, title: string): OkfTags | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try { json = JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
  const parsed = LlmOkf.safeParse(json);
  if (!parsed.success) return null;
  const tags = makeOkfTags({ ...parsed.data, title });
  return tags.tags.length ? tags : null;
}
