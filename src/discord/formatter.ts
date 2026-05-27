import { EmbedBuilder } from "discord.js";

export const DISCORD_MAX_CONTENT = 1900;

export function sessionChannelSlug(agentType: string | null, roleLabel: string | null): string {
  const agentPart = roleSlug(normalizeAgentType(agentType));
  const rolePart = roleSlug(roleLabel ?? "anon");
  return `${agentPart}-${rolePart}`.slice(0, 90);
}

function normalizeAgentType(agentType: string | null): string {
  const v = (agentType ?? "").trim().toLowerCase();
  if (v.startsWith("claude")) return "claude";
  if (v.startsWith("gemini")) return "gemini";
  if (v.startsWith("codex")) return "codex";
  if (!v) return "agent";
  return v;
}

export function roleSlug(role: string): string {
  const trimmed = role
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return trimmed || "role";
}

export function applyStatusEmoji(current: string, status: "active" | "lost" | "ended"): string {
  const stripped = current.replace(/^[^a-zA-Z0-9]*-?/u, "");
  const emoji = status === "active"
    ? "\u{1F7E2}"
    : status === "lost"
      ? "\u{1F7E5}"
      : "\u{26AA}";
  return `${emoji}-${stripped.replace(/^-/, "")}`;
}

export function chunkForDiscord(text: string, max = DISCORD_MAX_CONTENT): string[] {
  if (!text) return [];
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      out.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = remaining.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return out;
}

export function formatAuthorName(displayName: string | null, role: string | null): string {
  const name = displayName?.trim();
  const r = role?.trim();
  if (name && r && name !== r) return `${name} (${r})`;
  return name ?? r ?? "Concordia";
}

const COLOR = {
  chitchat: 0x7aa0ff,
  consultation: 0xffb347,
  houkoku: 0xffd700,
  system: 0x808080,
  transcript: 0x5865f2,
  statusActive: 0x57f287,
  statusLost: 0xed4245,
  question: 0xf1c40f,
} as const;

export function chatEmbed(input: { channel: string; text: string; authorName: string; ts: number }): EmbedBuilder {
  const color = (COLOR as Record<string, number>)[input.channel] ?? COLOR.system;
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: input.authorName })
    .setDescription(input.text.slice(0, 4000))
    .setTimestamp(new Date(input.ts * 1000));
}

export function transcriptEmbed(input: {
  sessionId: string;
  text: string;
  authorName: string;
  kind: "text" | "thinking" | "summary";
  ts: number;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR.transcript)
    .setAuthor({ name: input.authorName })
    .setDescription(input.text.slice(0, 4000))
    .setFooter({ text: `${input.kind} ? ${input.sessionId}` })
    .setTimestamp(new Date(input.ts * 1000));
}

export function statusEmbed(input: {
  sessionId: string;
  role: string | null;
  branch: string | null;
  lastEvent: { kind: string; ts: number } | null;
  conflicts: number;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(input.lastEvent?.kind === "lost" ? COLOR.statusLost : COLOR.statusActive)
    .setTitle("Session Status")
    .addFields(
      { name: "session", value: input.sessionId, inline: false },
      { name: "role", value: input.role ?? "-", inline: true },
      { name: "branch", value: input.branch ?? "-", inline: true },
      { name: "conflicts", value: String(input.conflicts), inline: true },
    )
    .setFooter({ text: input.lastEvent ? `last: ${input.lastEvent.kind}` : "last: -" });
}

export function reportEmbed(input: { sessionId: string; summary: string; highlights: string[] }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR.system)
    .setTitle(`Report: ${input.sessionId}`)
    .setDescription(input.summary.slice(0, 4000))
    .addFields(input.highlights.slice(0, 8).map((h, i) => ({ name: `#${i + 1}`, value: h.slice(0, 200) })));
}

export function questionEmbed(input: { question: string; options: string[]; questionId: number }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR.question)
    .setTitle("AskUserQuestion")
    .setDescription(input.question.slice(0, 4000))
    .addFields(input.options.slice(0, 25).map((x, i) => ({ name: `${i}`, value: x.slice(0, 100) })))
    .setFooter({ text: `question_id=${input.questionId}` });
}
