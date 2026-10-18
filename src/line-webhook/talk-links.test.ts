import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { MemoryLineTalkLinkStore, SqliteLineTalkLinkStore, type LineTalkLinkStore } from "./talk-links.js";

/** テスト値 (実物ではない)。 */
const GROUP = "C0000000000000000000000000000000a";
const OTHER = "C0000000000000000000000000000000b";

const stores: Array<[string, () => LineTalkLinkStore]> = [
  ["SQLite", () => new SqliteLineTalkLinkStore(makeTestDb())],
  ["メモリ", () => new MemoryLineTalkLinkStore()],
];

describe.each(stores)("トークごとの紐付け (%s)", (_label, make) => {
  it("トークで初めてつながったサービスがふだんの相手になり、2 つ目以降はならない", () => {
    const store = make();
    store.link("ludiars", GROUP, "mf", 1);
    store.link("ludiars", GROUP, "mm", 2);
    store.link("ludiars", GROUP, "mf", 3);
    expect(store.forTalk("ludiars", GROUP)).toEqual([
      { service: "mf", isDefault: true },
      { service: "mm", isDefault: false },
    ]);
    expect(store.forTalk("ludiars", OTHER)).toEqual([]);
    expect(store.forTalk("other", GROUP)).toEqual([]);
  });

  it("ふだんの相手を変えると、そのトークの他のサービスはふだんの相手でなくなる", () => {
    const store = make();
    store.link("ludiars", GROUP, "mf", 1);
    store.link("ludiars", GROUP, "mm", 2);
    store.link("ludiars", OTHER, "mf", 3);
    const mm = store.list().find((row) => row.talkId === GROUP && row.service === "mm")!;
    expect(store.setDefault(mm.id)).toBe(true);
    expect(store.forTalk("ludiars", GROUP)).toEqual([
      { service: "mf", isDefault: false },
      { service: "mm", isDefault: true },
    ]);
    expect(store.forTalk("ludiars", OTHER)).toEqual([{ service: "mf", isDefault: true }]);
    expect(store.setDefault(9999)).toBe(false);
  });

  it("解除・トークごと消去・サービス側の unlinked を反映する", () => {
    const store = make();
    store.link("ludiars", GROUP, "mf", 1);
    store.link("ludiars", GROUP, "mm", 2);
    store.link("ludiars", OTHER, "mm", 3);
    store.unlink("ludiars", GROUP, "mm");
    expect(store.forTalk("ludiars", GROUP)).toEqual([{ service: "mf", isDefault: true }]);
    const other = store.list().find((row) => row.talkId === OTHER)!;
    expect(store.remove(other.id)).toBe(true);
    expect(store.remove(other.id)).toBe(false);
    store.clearTalk("ludiars", GROUP);
    expect(store.list()).toEqual([]);
  });

  it("一覧はチャネル・トーク・サービス・ふだんの相手か・つないだ時刻を返す", () => {
    const store = make();
    store.link("ludiars", GROUP, "mf", 1234);
    expect(store.list()).toEqual([
      { id: expect.any(Number), channel: "ludiars", talkId: GROUP, service: "mf", isDefault: true, linkedAt: 1234 },
    ]);
  });
});
