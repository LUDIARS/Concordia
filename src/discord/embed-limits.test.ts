import { describe, expect, it } from "vitest";
import {
  clampLines,
  clampText,
  EMBED_LIMITS,
  fitEmbeds,
  sanitizeMentions,
  totalCharacters,
  type EmbedSpec,
} from "./embed-limits.js";

/** fitEmbeds の唯一の約束: これを通れば Discord に 400 で拒否されない。 */
function assertWithinDiscordLimits(embeds: readonly EmbedSpec[]): void {
  expect(embeds.length).toBeLessThanOrEqual(EMBED_LIMITS.embedsPerMessage);
  expect(totalCharacters(embeds)).toBeLessThanOrEqual(EMBED_LIMITS.totalCharacters);
  for (const embed of embeds) {
    expect((embed.title ?? "").length).toBeLessThanOrEqual(EMBED_LIMITS.title);
    expect((embed.description ?? "").length).toBeLessThanOrEqual(EMBED_LIMITS.description);
    expect((embed.footer?.text ?? "").length).toBeLessThanOrEqual(EMBED_LIMITS.footer);
    expect((embed.fields ?? []).length).toBeLessThanOrEqual(EMBED_LIMITS.fieldsPerEmbed);
    for (const field of embed.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldName);
      expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
      expect(field.value.length).toBeGreaterThan(0);
    }
  }
}

describe("sanitizeMentions", () => {
  it("@everyone / @here を発火しない形に壊す", () => {
    const out = sanitizeMentions("危険 @everyone と @here");
    expect(out).not.toContain("@everyone");
    expect(out).not.toContain("@here");
    // 読めることは保つ (削らない)。
    expect(out).toContain("everyone");
    expect(out).toContain("here");
  });

  it("ユーザ / ロールメンションを壊す", () => {
    expect(sanitizeMentions("<@123456789012345678>")).not.toContain("<@123456789012345678>");
    expect(sanitizeMentions("<@&987654321098765432>")).not.toContain("<@&987654321098765432>");
  });

  it("普通の文字列は変えない", () => {
    expect(sanitizeMentions("session-lifecycle ドメイン")).toBe("session-lifecycle ドメイン");
  });
});

describe("clampText", () => {
  it("上限内はそのまま", () => {
    expect(clampText("abc", 10)).toBe("abc");
  });

  it("超えたら省略を明示して上限内に収める", () => {
    const out = clampText("a".repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("以下省略");
  });

  it("上限が省略文言より短くても上限を守る", () => {
    expect(clampText("a".repeat(100), 5).length).toBe(5);
  });
});

describe("clampLines", () => {
  it("0 件は (なし)", () => {
    expect(clampLines([])).toBe("(なし)");
  });

  it("入り切らない行は件数で畳む", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `\`domain-${i}\` — 長めの説明文をここに置く`);
    const out = clampLines(lines);
    expect(out.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
    expect(out).toMatch(/以下省略 \(\d+ 件\)/);
  });
});

describe("fitEmbeds", () => {
  it("巨大な入力でも Discord の上限を 1 つも超えない", () => {
    const huge: EmbedSpec[] = Array.from({ length: 30 }, (_, index) => ({
      title: "t".repeat(500),
      description: "d".repeat(9_000),
      footer: { text: "f".repeat(4_000) },
      fields: Array.from({ length: 60 }, (_, field) => ({
        name: `n${index}-${field}`.repeat(50),
        value: "v".repeat(5_000),
      })),
    }));
    assertWithinDiscordLimits(fitEmbeds(huge));
  });

  it("落とした field と embed は件数で明示する", () => {
    const embeds: EmbedSpec[] = [{
      title: "t",
      fields: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: `v${i}` })),
    }];
    const fitted = fitEmbeds(embeds);
    expect(fitted[0]!.fields).toHaveLength(EMBED_LIMITS.fieldsPerEmbed);
    expect(fitted[0]!.fields!.at(-1)!.value).toContain("以下省略");
  });

  it("メンションは field と description の両方で無害化される", () => {
    const fitted = fitEmbeds([{
      description: "@everyone 見て",
      fields: [{ name: "@here", value: "<@123456789012345678> 宛て" }],
    }]);
    expect(fitted[0]!.description).not.toContain("@everyone");
    expect(fitted[0]!.fields![0]!.name).not.toContain("@here");
    expect(fitted[0]!.fields![0]!.value).not.toContain("<@123456789012345678>");
  });

  it("空の field value は Discord に拒否されるので (なし) で埋める", () => {
    const fitted = fitEmbeds([{ fields: [{ name: "空", value: "" }] }]);
    expect(fitted[0]!.fields![0]!.value).toBe("(なし)");
  });
});
