import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const MEMORIA_BASE = (process.env.MEMORIA_BASE ?? "http://127.0.0.1:5180").replace(/\/$/, "");

interface TaskRow {
  id: number;
  title: string;
  details: string | null;
  status: string;
  due_at: string | null;
  category: string | null;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchTasks(): Promise<TaskRow[] | null> {
  try {
    const res = await fetch(`${MEMORIA_BASE}/api/tasks?limit=200`);
    if (!res.ok) return null;
    const { items } = await res.json() as { items: TaskRow[] };
    return items;
  } catch {
    return null;
  }
}

function buildText(rows: TaskRow[], label: string): string {
  if (rows.length === 0) return `(${label} — 該当タスクなし)`;

  rows.sort((a, b) =>
    (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1)
    || String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999"))
    || a.id - b.id,
  );

  const lines: string[] = [`## Memoria タスク — ${label}\n`];
  for (const t of rows.slice(0, 20)) {
    const due = t.due_at ? ` 期日:${t.due_at.slice(0, 10)}` : "";
    const cate = t.category ? ` [${t.category}]` : "";
    const flag = t.status === "doing" ? "▶" : "・";
    lines.push(`${flag} #${t.id}${cate} ${t.title}${due}`);
    if (t.details) {
      const d = t.details.replace(/\s+/g, " ").trim();
      lines.push(`    ${d.slice(0, 100)}${d.length > 100 ? "…" : ""}`);
    }
  }
  if (rows.length > 20) lines.push(`\n…他 ${rows.length - 20} 件`);
  lines.push(`\n${rows.length} 件`);
  return lines.join("\n");
}

const mmtaskCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("mmtask")
    .setDescription("Memoria タスク残作業検索 → セッションに注入 (引数なし=今日期限)")
    .addStringOption((o) =>
      o.setName("query").setDescription("プロジェクトコード / カテゴリ / キーワード"),
    ),

  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;

    await interaction.deferReply({ ephemeral: true });

    const allTasks = await fetchTasks();
    if (!allTasks) {
      await interaction.editReply({ content: `Memoria に接続できませんでした (${MEMORIA_BASE})。` });
      return;
    }

    const query = interaction.options.getString("query");
    let rows = allTasks.filter((t) => t.status !== "done");
    let label: string;

    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((t) =>
        t.title.toLowerCase().includes(q)
        || (t.details ?? "").toLowerCase().includes(q)
        || (t.category ?? "").toLowerCase().includes(q),
      );
      label = `"${query}" の検索結果`;
    } else {
      const today = todayStr();
      rows = rows.filter((t) => t.due_at?.startsWith(today));
      label = `今日期限 (${today})`;
    }

    const text = buildText(rows, label);

    const r = await callConcordia<{ ok: boolean }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/inject`,
      {
        text,
        source: `discord:${interaction.user.id}:mmtask`,
        author_label: interaction.user.displayName,
      },
    );

    if ("error" in r) {
      await interaction.editReply({ content: `inject 失敗: ${r.error}` });
      return;
    }

    await interaction.editReply({ content: `セッションに注入しました (${rows.length} 件)` });
  },
};

export default mmtaskCommand;
