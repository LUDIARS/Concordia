import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";

interface Category {
  name: string;
  entries: [string, string][]; // [code, repo]
}

const CATEGORIES: Category[] = [
  {
    name: "メタ / インフラ",
    entries: [
      ["L/Ld", "LUDIARS"],
      ["In", "infra"],
      ["Af", "AIFormat"],
      ["Ao", "All-In-OneTest"],
    ],
  },
  {
    name: "コアエンジン / SDK",
    entries: [
      ["Ar", "Ars"],
      ["Eg", "Ergo"],
      ["Pc", "Pictor"],
      ["Lp", "Lapilli"],
      ["Vg", "Vestigium"],
      ["Ci", "Canalis"],
      ["Lc", "Lector"],
    ],
  },
  {
    name: "認証 / 通知",
    entries: [
      ["Cr", "Cernere"],
      ["Nt", "Nuntius"],
      ["Os", "Ostiarius"],
    ],
  },
  {
    name: "スケジュール / タスク",
    entries: [
      ["At/A", "Actio"],
      ["Sc", "Schedula"],
      ["Ap", "Actio-PublicModules"],
      ["As", "Actio-SchoolModules"],
      ["Ca", "Calicula"],
      ["Ae", "Aedilis"],
      ["Di", "Discutere"],
    ],
  },
  {
    name: "ゲーム",
    entries: [
      ["AC", "AdventureCube"],
      ["KS", "KuzuSurvivors"],
      ["Ul", "UniLand"],
      ["Lu", "Ludus"],
    ],
  },
  {
    name: "ネットワーク",
    entries: [
      ["Sy", "Synergos"],
      ["Te", "Tessera"],
      ["Cx", "Codex"],
      ["Vc", "VTN-Connect"],
    ],
  },
  {
    name: "アセット / ツール",
    entries: [
      ["Cu", "Curare"],
      ["Cl", "Clio"],
      ["Si", "Signum"],
      ["Iv", "Imperativus"],
      ["It", "Iter"],
      ["Mm", "Memoria"],
      ["Cs", "Custos"],
      ["Su", "Susurrus"],
      ["Bb", "Bibliotheca"],
      ["Qu", "Quaestor"],
      ["Cn", "Conciliator"],
      ["Pf", "Praeforma"],
      ["Tr", "Tirocinium"],
      ["Li", "Lictor"],
      ["Hr", "Hora"],
      ["Ll", "Ludellus-Server"],
    ],
  },
  {
    name: "Hub / 運用協調",
    entries: [
      ["Cc", "Concordia"],
      ["Co", "Corpus"],
      ["Ex", "Excubitor"],
      ["Fa", "Famulus"],
      ["Lg", "Legatus"],
      ["Vh", "VantanHub"],
    ],
  },
  {
    name: "Ars プラグイン",
    entries: [
      ["Am", "Ars-Module"],
      ["Au", "Ars-Musa"],
      ["Ax", "Ars-PlatformPlugin"],
    ],
  },
];

const projectsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("projects")
    .setDescription("LUDIARS プロジェクトコード一覧を表示"),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle("LUDIARS プロジェクトコード一覧")
      .setColor(0x5865f2)
      .setFooter({ text: "正本: LUDIARS/PROJECT-CODES.md" });

    for (const cat of CATEGORIES) {
      const value = cat.entries.map(([code, repo]) => `\`${code}\` ${repo}`).join("\n");
      embed.addFields({ name: cat.name, value, inline: false });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default projectsCommand;
