/** @implements spec/feature/dependency-readiness.md — Discord read-only surface */
import { SlashCommandBuilder } from "discord.js";
import type { DependencyReadinessReport } from "../../operations/dependency-readiness.js";
import type { DiscordCommandSpec } from "../command-port.js";

const ICON = { ok: "OK", warn: "WARN", error: "NG" } as const;

const doctorCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-doctor")
    .setDescription("Anatomia / Augur / Memoria / Actio / Revisor の設定・接続を確認する"),
  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    if (!deps.checkDependencies) {
      await interaction.editReply({ content: "依存サービス診断が配線されていません。" });
      return;
    }
    let report: DependencyReadinessReport;
    try {
      report = await deps.checkDependencies();
    } catch {
      await interaction.editReply({
        content: "依存サービス診断に失敗しました。",
      });
      return;
    }
    if (!report.excubitorReachable) {
      await interaction.editReply({ content: "NG Excubitor: catalog/liveness API unavailable" });
      return;
    }
    const lines = report.items.map((item) =>
      `${ICON[item.state]} **${item.project}** \`${item.serviceCode}\`: ${item.detail}`,
    );
    await interaction.editReply({
      content: ["**Cc dependency doctor**", ...lines, `checked: ${report.checkedAt}`].join("\n").slice(0, 1900),
      allowedMentions: { parse: [] },
    });
  },
};

export default doctorCommand;
