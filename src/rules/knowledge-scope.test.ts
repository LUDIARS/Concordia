import { describe, expect, it } from "vitest";
import { allowsHqKnowledge, chunkText, excludeConfidential, knowledgeScopeOf } from "./knowledge-scope.js";
import type { KnowledgeDoc } from "./knowledge-types.js";

function doc(over: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    docType: "readme", docKey: "repo:Ex:README.md", title: "Example README", url: null, repo: "Example", path: "README.md",
    scope: "hq", text: "example body", sourceUpdatedAt: null, ...over,
  };
}

describe("knowledgeScopeOf (chat-knowledge-C-1)", () => {
  const row = { code: "Ex", project: "Example", repoOrigin: "https://github.com/example-org/Example" };

  it("is hq unless the project is explicitly listed as public", () => {
    expect(knowledgeScopeOf(row, [])).toBe("hq");
    expect(knowledgeScopeOf(row, ["Other"])).toBe("hq");
  });

  it("is public when listed by code or name (case-insensitive)", () => {
    expect(knowledgeScopeOf(row, ["ex"])).toBe("public");
    expect(knowledgeScopeOf(row, [" example "])).toBe("public");
  });

  it("keeps MELPOT-owned repositories hq even when listed", () => {
    expect(knowledgeScopeOf({ ...row, repoOrigin: "https://github.com/MELPOT/Example" }, ["Ex"])).toBe("hq");
    expect(knowledgeScopeOf({ ...row, repoOrigin: "git@github.com:melpot/Example.git" }, ["Ex"])).toBe("hq");
  });

  it("treats an unknown origin by the explicit list only", () => {
    expect(knowledgeScopeOf({ ...row, repoOrigin: null }, [])).toBe("hq");
  });
});

describe("allowsHqKnowledge (chat-knowledge-C-2)", () => {
  it("allows hq only for a head-office rule on the hq meta channel", () => {
    expect(allowsHqKnowledge({ subsidiaryId: null, scopeKey: "hq", discordChannelId: null })).toBe(true);
    expect(allowsHqKnowledge({ subsidiaryId: "sub-1", scopeKey: "hq", discordChannelId: null })).toBe(false);
    expect(allowsHqKnowledge({ subsidiaryId: null, scopeKey: "public", discordChannelId: null })).toBe(false);
    expect(allowsHqKnowledge({ subsidiaryId: null, scopeKey: "hq", discordChannelId: "100000000000000001" })).toBe(false);
  });
});

describe("excludeConfidential (chat-knowledge-C-3)", () => {
  it("drops documents that contain a dictionary term anywhere, case-insensitively", () => {
    const docs = [
      doc({ docKey: "a", text: "about the Hidden-Word plan" }),
      doc({ docKey: "b", title: "hidden-word notes", text: "x" }),
      doc({ docKey: "c", path: "spec/hidden-word.md", text: "x" }),
      doc({ docKey: "d", text: "nothing secret" }),
    ];
    const out = excludeConfidential(docs, ["HIDDEN-WORD", " "]);
    expect(out.docs.map((d) => d.docKey)).toEqual(["d"]);
    expect(out.excluded).toBe(3);
  });

  it("keeps everything when the dictionary is empty", () => {
    expect(excludeConfidential([doc()], [])).toEqual({ docs: [doc()], excluded: 0 });
  });
});

describe("chunkText", () => {
  it("splits by byte budget and caps the number of chunks", () => {
    const text = Array.from({ length: 20 }, (_, i) => `段落${i} ${"あ".repeat(80)}`).join("\n\n");
    const chunks = chunkText(text, 300, 3);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(300);
  });

  it("returns nothing for blank text", () => {
    expect(chunkText("  \n\n ", 300, 3)).toEqual([]);
  });
});
