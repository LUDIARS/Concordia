/**
 * 個人の AI 予算の Discord 側の adapter。 `/budget`・`/reward` が要る操作と、 本人への通知 (DM) を
 * Discord の語彙から use case へつなぐ。 判断は personal-budget の純関数と use case が持つ。
 *
 * 会社の所属は社員名簿ではなく、 その子会社の guild に在籍するかで確かめる (staff-roster.md §9)。
 * 在籍を確かめられないときは付けずに理由を返す (個人を特定できない場合の扱い、 §10)。
 *
 * @implements SPEC-PBUDGET-ADJUST
 * @implements SPEC-PBUDGET-VIEW
 * @implements spec/feature/personal-ai-budget.md §6 / §7
 */

import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { createPersonalBudget } from "../personal-budget/composition.js";
import { formatTokens, renderBudgetView } from "../personal-budget/format.js";
import { PersonalBudgetNotifications } from "../personal-budget/notification-service.js";
import { guildMemberIds } from "./guild-member-ids.js";

export interface RewardCommandInput {
  actorUserId: string;
  targetUserId: string;
  targetLabel: string;
  tokens: number;
  reason: string;
  /** `subsidiary` オプション (子会社 id)。 未指定なら null。 */
  subsidiaryId: string | null;
}

export interface PersonalBudgetCommandDeps {
  /** `/budget` の本文 (本人にだけ返す)。 */
  renderBudget(userId: string): string;
  /** `/reward` を実行し、 操作者へ返す本文を返す。 */
  reward(input: RewardCommandInput): Promise<string>;
  /** `subsidiary` オプションの候補。 */
  subsidiaryChoices(): Array<{ id: string; name: string }>;
}

export interface PersonalBudgetDiscordDeps {
  db: Database.Database;
  client: Pick<Client, "guilds" | "users">;
  /** この Bot の会社。 本社 Bot は null。 */
  runtimeSubsidiaryId: string | null;
  /** 社員名簿の権限者 (管理職以上) か。 */
  isApprover: (userId: string) => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export interface PersonalBudgetDiscord {
  commands: PersonalBudgetCommandDeps;
  notifications: PersonalBudgetNotifications;
}

export function createPersonalBudgetDiscord(deps: PersonalBudgetDiscordDeps): PersonalBudgetDiscord {
  const subsidiaries = new SubsidiaryRepo(deps.db);
  const budget = createPersonalBudget({
    db: deps.db,
    subsidiaryMonthlyDefault: (subsidiaryId) => subsidiaries.find(subsidiaryId)?.personal_monthly_token_budget ?? null,
    // Bot は払い出しの判定も報奨の加算量も使わない (表示と調整だけ)。
    isGlobalOver: () => false,
    readSetting: () => null,
    log: deps.log,
  });
  const companies = () => subsidiaries.list().filter((row) => row.mode === "subsidiary");
  const companyName = (subsidiaryId: string): string => {
    const row = subsidiaries.find(subsidiaryId);
    return row ? row.display_name || row.name : subsidiaryId;
  };

  /** その人が在籍する子会社の id。 確かめられなければ throw する。 */
  const membershipsOf = async (userId: string, onlySubsidiaryId: string | null): Promise<string[]> => {
    const memberships: string[] = [];
    for (const company of companies()) {
      if (onlySubsidiaryId && company.id !== onlySubsidiaryId) continue;
      if (company.platform !== "discord" || !company.guild_id) continue;
      const guild = await deps.client.guilds.fetch(company.guild_id);
      if ((await guildMemberIds(guild, [userId])).length > 0) memberships.push(company.id);
    }
    return memberships;
  };

  const commands: PersonalBudgetCommandDeps = {
    renderBudget: (userId) => renderBudgetView(
      budget.view.forUser({ platform: "discord", platformUserId: userId, subsidiaryId: deps.runtimeSubsidiaryId }),
      companyName,
    ),
    reward: async (input) => {
      // 権限の無い操作者には、 対象の所属を調べる前に断る (在籍の有無を漏らさない)。
      if (!deps.isApprover(input.actorUserId)) {
        return "報酬の調整は本社の権限者 (管理職以上) だけが行えます。";
      }
      if (input.subsidiaryId && !companies().some((company) => company.id === input.subsidiaryId)) {
        return "指定した子会社が見つかりません。候補から選んでください。";
      }
      let memberships: string[];
      try {
        memberships = await membershipsOf(input.targetUserId, input.subsidiaryId);
      } catch (error) {
        deps.log.warn(`personal budget membership check failed: ${(error as Error).message}`);
        return "対象の所属 (子会社の在籍) を確かめられなかったため、調整していません。時間をおいてやり直してください。";
      }
      const outcome = budget.adjustments.adjust({
        // 可否は use case がもう一度確かめる (CC-PBUDGET-INV-06)。
        actor: { id: `discord:${input.actorUserId}`, authorized: deps.isApprover(input.actorUserId) },
        target: {
          platform: "discord",
          platformUserId: input.targetUserId,
          displayName: input.targetLabel,
          memberships,
          requestedSubsidiaryId: input.subsidiaryId,
        },
        tokens: input.tokens,
        reason: input.reason,
      });
      if (!outcome.ok) {
        const candidates = outcome.candidates.length > 0
          ? `\n候補: ${outcome.candidates.map(companyName).join(" / ")}`
          : "";
        return `${outcome.message}${candidates}`;
      }
      deps.log.info(`personal budget adjusted person=${outcome.person.id} actor=discord:${input.actorUserId}`);
      const applied = outcome.entry.tokens;
      const note = applied !== input.tokens ? " (残高 0 までに収めました)" : "";
      return [
        `${input.targetLabel} (${companyName(outcome.person.subsidiary_id)}) の報酬分を `
          + `${applied >= 0 ? "+" : "-"}${formatTokens(Math.abs(applied))} しました${note}。`,
        `報酬分の残り: ${formatTokens(outcome.rewardBalance)}`,
        "本人へは DM で知らせます (届かなくても調整は確定です)。",
      ].join("\n");
    },
    subsidiaryChoices: () => companies().map((company) => ({ id: company.id, name: company.display_name || company.name })),
  };

  const notifications = new PersonalBudgetNotifications({
    notices: budget.ledger,
    person: (id) => budget.people.findById(id),
    companyName,
    send: async (person, text) => {
      if (person.platform !== "discord") throw new Error(`unsupported platform: ${person.platform}`);
      const user = await deps.client.users.fetch(person.platform_user_id);
      await user.send({ content: text, allowedMentions: { parse: [] } });
    },
    log: deps.log,
  });

  return { commands, notifications };
}
