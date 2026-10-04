import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PersonalBudgetLedgerRepo } from "../db/personal-budget-ledger-repo.js";
import { PersonalBudgetPeopleRepo } from "../db/personal-budget-people-repo.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { createPersonalBudgetDiscord, type PersonalBudgetDiscord } from "./personal-budget-discord.js";

const UNKNOWN_MEMBER = Object.assign(new Error("Unknown Member"), { code: 10007 });

let db: ReturnType<typeof makeTestDb>;
let people: PersonalBudgetPeopleRepo;
let ledger: PersonalBudgetLedgerRepo;
let glabId: string;
let vantanId: string;
/** guild id → その guild に在籍する user id。 */
let members: Map<string, Set<string>>;
let guildFetchFails: boolean;
let sent: Array<{ userId: string; content: string }>;
let warn: ReturnType<typeof vi.fn>;

function wire(options: { runtimeSubsidiaryId?: string | null; approvers?: string[] } = {}): PersonalBudgetDiscord {
  const client = {
    guilds: {
      fetch: async (guildId: string) => {
        if (guildFetchFails) throw new Error("Missing Access");
        return {
          members: {
            fetch: async (userId: string) => {
              if (!members.get(guildId)?.has(userId)) throw UNKNOWN_MEMBER;
              return { id: userId };
            },
          },
        };
      },
    },
    users: {
      fetch: async (userId: string) => ({
        send: async (message: { content: string }) => { sent.push({ userId, content: message.content }); },
      }),
    },
  } as unknown as Pick<Client, "guilds" | "users">;
  return createPersonalBudgetDiscord({
    db,
    client,
    runtimeSubsidiaryId: options.runtimeSubsidiaryId ?? null,
    isApprover: (userId) => (options.approvers ?? ["900"]).includes(userId),
    log: { info: vi.fn(), warn },
  });
}

const reward = (overrides: Partial<Parameters<PersonalBudgetDiscord["commands"]["reward"]>[0]> = {}) => ({
  actorUserId: "900", targetUserId: "111", targetLabel: "alice", tokens: 500_000, reason: "勉強会の登壇", subsidiaryId: null,
  ...overrides,
});

beforeEach(() => {
  db = makeTestDb();
  people = new PersonalBudgetPeopleRepo(db);
  ledger = new PersonalBudgetLedgerRepo(db);
  const subsidiaries = new SubsidiaryRepo(db);
  glabId = subsidiaries.create({ name: "glab", display_name: "GLAB", platform: "discord", enabled: true, guild_id: "guild-glab" }).id;
  vantanId = subsidiaries.create({ name: "vantan", display_name: "Vantan", platform: "discord", enabled: true, guild_id: "guild-vantan" }).id;
  // 本社内 desk は会社ではないので、 所属の候補に入らない。
  subsidiaries.create({ name: "desk", platform: "discord", enabled: true, mode: "desk", guild_id: "guild-hq" });
  members = new Map([["guild-glab", new Set(["111"])], ["guild-vantan", new Set<string>()], ["guild-hq", new Set(["111", "900"])]]);
  guildFetchFails = false;
  sent = [];
  warn = vi.fn();
});

describe("/reward の実行 (SPEC-PBUDGET-ADJUST)", () => {
  it("子会社の guild に在籍する人の報酬分を増やし、 誰が・なぜを台帳に残す", async () => {
    const text = await wire().commands.reward(reward());
    expect(text).toContain("alice (GLAB) の報酬分を +500,000 しました");
    expect(text).toContain("報酬分の残り: 500,000");

    const person = people.find({ subsidiaryId: glabId, platform: "discord", platformUserId: "111" })!;
    expect(ledger.listForPerson(person.id, { limit: 5, offset: 0 }).entries[0]).toMatchObject({
      entry_type: "manual", tokens: 500_000, actor: "discord:900", reason: "勉強会の登壇",
    });
  });

  it("権限者でない操作者は、 対象の在籍を調べる前に断る (CC-PBUDGET-INV-06)", async () => {
    const adapter = wire({ approvers: [] });
    guildFetchFails = true;
    expect(await adapter.commands.reward(reward())).toContain("本社の権限者");
    expect(people.list({ limit: 10, offset: 0 }).total).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("どの子会社にも在籍しない人 (本社メンバー) への調整は受けず、 理由を返す", async () => {
    const text = await wire().commands.reward(reward({ targetUserId: "900", targetLabel: "boss" }));
    expect(text).toContain("本社メンバーへの調整は受け付けません");
    expect(people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("複数の子会社に在籍する人は、 subsidiary の指定を求めて候補を返す", async () => {
    members.get("guild-vantan")!.add("111");
    const adapter = wire();
    const ambiguous = await adapter.commands.reward(reward());
    expect(ambiguous).toContain("subsidiary を指定してください");
    expect(ambiguous).toContain("GLAB / Vantan");
    expect(people.list({ limit: 10, offset: 0 }).total).toBe(0);

    expect(await adapter.commands.reward(reward({ subsidiaryId: vantanId }))).toContain("alice (Vantan)");
    expect(people.find({ subsidiaryId: vantanId, platform: "discord", platformUserId: "111" })).not.toBeNull();
  });

  it("指定した子会社に在籍しない人・存在しない子会社は断る", async () => {
    const adapter = wire();
    expect(await adapter.commands.reward(reward({ subsidiaryId: vantanId }))).toContain("指定した子会社に所属していません");
    expect(await adapter.commands.reward(reward({ subsidiaryId: "sub-missing" }))).toContain("指定した子会社が見つかりません");
  });

  it("在籍を確かめられないときは付けずに理由を返す", async () => {
    guildFetchFails = true;
    const text = await wire().commands.reward(reward());
    expect(text).toContain("確かめられなかったため、調整していません");
    expect(people.list({ limit: 10, offset: 0 }).total).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("減額は残高 0 までに収め、 そのことを操作者へ伝える", async () => {
    const adapter = wire();
    await adapter.commands.reward(reward({ tokens: 300 }));
    const text = await adapter.commands.reward(reward({ tokens: -1_000, reason: "誤付与の訂正" }));
    expect(text).toContain("-300 しました (残高 0 までに収めました)");
    expect(text).toContain("報酬分の残り: 0");
  });

  it("理由の無い調整は受けない", async () => {
    expect(await wire().commands.reward(reward({ reason: "  " }))).toContain("理由を入力してください");
  });
});

describe("/budget の本文と候補", () => {
  it("子会社の Bot ではその会社の分だけ、 本社の Bot ではその人の全社分を出す", async () => {
    members.get("guild-vantan")!.add("111");
    const hq = wire();
    await hq.commands.reward(reward({ subsidiaryId: glabId, tokens: 100 }));
    await hq.commands.reward(reward({ subsidiaryId: vantanId, tokens: 200 }));

    const all = hq.commands.renderBudget("111");
    expect(all).toContain("GLAB");
    expect(all).toContain("Vantan");
    const glabOnly = wire({ runtimeSubsidiaryId: glabId }).commands.renderBudget("111");
    expect(glabOnly).toContain("GLAB");
    expect(glabOnly).not.toContain("Vantan");
    expect(hq.commands.renderBudget("404")).toContain("記録はまだありません");
  });

  it("subsidiary の候補に本社内 desk を出さない", () => {
    expect(wire().commands.subsidiaryChoices()).toEqual([{ id: glabId, name: "GLAB" }, { id: vantanId, name: "Vantan" }]);
  });
});

describe("本人への通知 (DM)", () => {
  it("調整を本人へ DM で知らせる", async () => {
    const adapter = wire();
    await adapter.commands.reward(reward());
    expect(await adapter.notifications.deliverPending()).toEqual({ delivered: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: "111" });
    expect(sent[0]!.content).toContain("GLAB");
    expect(sent[0]!.content).toContain("+500,000 本社の調整: 勉強会の登壇");
  });
});
