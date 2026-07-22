import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { discordCommandQueue } from "../background-task-queue.js";
import {
  excubitorBaseUrl,
  excubitorProjectCache,
  type ExcubitorComponentLite,
  type ExcubitorProjectLite,
} from "../excubitor-project-cache.js";

const CONTROLLABLE_RUNTIMES = new Set(["node", "dev-process-md", "app", "docker-compose", "docker"]);
const RUNNING_STATES = new Set(["running", "healthy"]);

interface ExcubitorControlResult {
  ok: boolean;
  action: "start" | "restart";
  exit_code?: number;
  command?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function buildCommand(name: "ex-run" | "ex-reboot", action: "start" | "restart", description: string): DiscordCommandSpec {
  return {
    builder: new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .addStringOption((o) =>
        o.setName("project")
          .setDescription("Excubitor dashboard project")
          .setRequired(true)
          .setAutocomplete(true)),

    async autocomplete(interaction, deps) {
      const focused = interaction.options.getFocused().toLowerCase();
      const baseUrl = excubitorBaseUrl();
      const cached = await excubitorProjectCache.get(baseUrl, deps.log);
      const choices = cached.projects
        .filter((p) => matchesProject(p, focused))
        .slice(0, 25)
        .map((p) => ({
          name: projectChoiceName(p),
          value: p.project_code,
        }));
      deps.log.info(
        `${name} autocomplete respond projects=${cached.projects.length} choices=${choices.length} ` +
        `source=${cached.source} refreshing=${cached.refreshing ? 1 : 0}`,
      );
      await interaction.respond(choices);
    },

    async execute(interaction, deps) {
      const projectCode = interaction.options.getString("project", true).trim();
      const baseUrl = excubitorBaseUrl();
      await interaction.deferReply({ ephemeral: false });

      const cached = await excubitorProjectCache.get(baseUrl, deps.log);
      let project = findProject(cached.projects, projectCode);
      if (!project || cached.source === "empty") {
        excubitorProjectCache.invalidate();
        const refreshed = await excubitorProjectCache.get(baseUrl, deps.log);
        project = findProject(refreshed.projects, projectCode);
      }

      if (!project) {
        await interaction.editReply({ content: `Ex ${action} failed: project \`${projectCode}\` was not found.` });
        return;
      }

      const targets = controlTargets(project, action);
      if (targets.length === 0) {
        await interaction.editReply({ content: `Ex ${action}: no controllable components in \`${project.project_code}\`.` });
        return;
      }

      deps.log.info(
        `${name} execute project=${project.project_code} action=${action} targets=${targets.map((c) => c.code).join(",")} ` +
        `guild=${interaction.guildId ?? "-"} channel=${interaction.channelId ?? "-"} user=${interaction.user.id}`,
      );
      await interaction.editReply({
        content: `Ex ${action} queued for \`${project.project_code}\`: ${targets.map((c) => `\`${c.code}\``).join(", ")}`,
      });
      discordCommandQueue.enqueue(`${name} ${project.project_code}`, async () => {
        const results: Array<{ component: ExcubitorComponentLite; result: ExcubitorControlResult }> = [];
        for (const component of targets) {
          results.push({ component, result: await controlExcubitorService(baseUrl, component.code, action) });
        }

        excubitorProjectCache.invalidate();
        const failed = results.filter((r) => !r.result.ok);
        const title = failed.length === 0
          ? `Ex ${action} requested for \`${project.project_code}\`.`
          : `Ex ${action} completed with ${failed.length} failure(s) for \`${project.project_code}\`.`;
        await interaction.editReply({ content: formatControlSummary(title, results) }).catch(() => { /* self-restart can close the process first */ });
      });
    },
  };
}

export const exRunCommand = buildCommand("ex-run", "start", "Start an Excubitor dashboard project");
export const exRebootCommand = buildCommand("ex-reboot", "restart", "Restart an Excubitor dashboard project");

function matchesProject(project: ExcubitorProjectLite, focused: string): boolean {
  if (!focused) return true;
  const haystack = [
    project.project_code,
    project.project_name,
    ...project.components.flatMap((c) => [c.code, c.name, c.component ?? ""]),
  ].join(" ").toLowerCase();
  return haystack.includes(focused);
}

function projectChoiceName(project: ExcubitorProjectLite): string {
  const componentCodes = project.components.map((c) => c.code).slice(0, 4).join(", ");
  const suffix = componentCodes ? ` - ${componentCodes}${project.components.length > 4 ? ", ..." : ""}` : "";
  return `${project.project_code}${suffix}`.slice(0, 100);
}

function findProject(projects: ExcubitorProjectLite[], value: string): ExcubitorProjectLite | null {
  const lowered = value.toLowerCase();
  return projects.find((p) => p.project_code.toLowerCase() === lowered || p.project_name.toLowerCase() === lowered) ?? null;
}

function controlTargets(project: ExcubitorProjectLite, action: "start" | "restart"): ExcubitorComponentLite[] {
  return project.components
    .filter((c) => !c.disabled)
    .filter((c) => !c.monitor_only)
    .filter((c) => CONTROLLABLE_RUNTIMES.has(c.runtime ?? ""))
    .filter((c) => action === "restart" || !RUNNING_STATES.has(c.state ?? ""))
    .sort((a, b) => Number(a.code === "concordia") - Number(b.code === "concordia"));
}

async function controlExcubitorService(
  baseUrl: string,
  code: string,
  action: "start" | "restart",
): Promise<ExcubitorControlResult> {
  const res = await fetch(`${baseUrl}/api/v1/services/${encodeURIComponent(code)}/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-concordia-actor": "discord-command",
    },
    body: JSON.stringify({ action }),
  }).catch((err: unknown) => ({
    ok: false,
    status: 0,
    text: async () => JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
  } as Response));

  const text = await res.text();
  const json = text ? (JSON.parse(text) as ExcubitorControlResult) : { ok: res.ok, action };
  if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
  return json;
}

function formatControlSummary(
  title: string,
  results: Array<{ component: ExcubitorComponentLite; result: ExcubitorControlResult }>,
): string {
  const lines = results.map(({ component, result }) => {
    const detail = result.ok
      ? trimDetail(result.stdout || result.command || "ok")
      : trimDetail(result.error || result.stderr || result.stdout || "failed");
    return `${result.ok ? "OK" : "NG"} \`${component.code}\`: ${detail}`;
  });
  return [title, ...lines].join("\n").slice(0, 1900);
}

function trimDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180) || "-";
}
