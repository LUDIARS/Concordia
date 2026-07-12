import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import type {
  SessionRow,
  DelegationTemplateLite,
  HostSnapshot,
  SubsidiarySummary,
  DiscordConfigStatus,
  SlackConfigStatus,
  ProjectSufficiency,
} from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { DelegationSpawnForm } from "../../components/DelegationSpawnForm.js";

function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
  return n.toLocaleString("en-US");
}

type ConnectionState = "loading" | "running" | "stopped" | "missing" | "disabled" | "error";
type PlatformConnection = {
  label: "Discord" | "Slack";
  state: ConnectionState;
  detail: string;
  title?: string;
};

function shortId(value: string | null | undefined): string {
  if (!value) return "";
  return value.length <= 10 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function anatomiaBadge(sufficiency: ProjectSufficiency | undefined): string {
  if (!sufficiency?.anatomia.present) return "An —";
  return `An ✓ fn=${sufficiency.anatomia.functions ?? 0} dom=${sufficiency.anatomia.domains ?? 0}`;
}

function thaleiaBadge(sufficiency: ProjectSufficiency | undefined): string {
  if (!sufficiency?.thaleia.present) return "Th —";
  return `Th ✓ ${sufficiency.thaleia.implementedSpecs ?? 0}/${sufficiency.thaleia.specs ?? 0} gap=${sufficiency.thaleia.gapCount ?? 0}`;
}

export function SufficiencyBadges({ sufficiency }: { sufficiency?: ProjectSufficiency }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px]">
      <span className={`rounded px-1.5 py-0.5 ${sufficiency?.anatomia.present ? "bg-ok/10 text-ok" : "bg-muted text-subtle"}`}>
        {anatomiaBadge(sufficiency)}
      </span>
      <span className={`rounded px-1.5 py-0.5 ${sufficiency?.thaleia.present ? "bg-accent/10 text-accent" : "bg-muted text-subtle"}`}>
        {thaleiaBadge(sufficiency)}
      </span>
    </span>
  );
}

function missingDetail(parts: string[]): string {
  return `missing ${parts.slice(0, 3).join("/")}${parts.length > 3 ? "+" : ""}`;
}

function connectionTone(state: ConnectionState): string {
  switch (state) {
    case "running":
      return "border-ok/40 bg-ok/10 text-ok";
    case "error":
    case "missing":
      return "border-danger/40 bg-danger/10 text-danger";
    case "stopped":
      return "border-warn/40 bg-warn/10 text-warn";
    case "disabled":
    case "loading":
      return "border-border bg-muted text-subtle";
  }
}

function compactError(error: string): string {
  const trimmed = error.trim();
  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed;
}

function headDiscordConnection(status: DiscordConfigStatus | null | undefined): PlatformConnection {
  if (status === undefined) return { label: "Discord", state: "loading", detail: "checking" };
  if (status === null) return { label: "Discord", state: "error", detail: "status unavailable" };
  if (!status.runtime.embedded_enabled) return { label: "Discord", state: "disabled", detail: "embedded off" };
  if (!status.enabled) return { label: "Discord", state: "disabled", detail: "disabled" };
  const missing = [
    !status.token_set ? "token" : null,
    !status.guild_id ? "guild" : null,
  ].filter((v): v is string => !!v);
  if (missing.length > 0) return { label: "Discord", state: "missing", detail: missingDetail(missing) };
  if (status.runtime.running) {
    return { label: "Discord", state: "running", detail: `guild ${shortId(status.guild_id)}` };
  }
  if (status.runtime.last_error) {
    return {
      label: "Discord",
      state: "error",
      detail: compactError(status.runtime.last_error),
      title: status.runtime.last_error,
    };
  }
  return { label: "Discord", state: "stopped", detail: status.runtime.last_status ?? "not running" };
}

function headSlackConnection(status: SlackConfigStatus | null | undefined): PlatformConnection {
  if (status === undefined) return { label: "Slack", state: "loading", detail: "checking" };
  if (status === null) return { label: "Slack", state: "error", detail: "status unavailable" };
  if (!status.runtime.embedded_enabled) return { label: "Slack", state: "disabled", detail: "embedded off" };
  if (!status.enabled) return { label: "Slack", state: "disabled", detail: "disabled" };
  const missing = [
    !status.bot_token_set ? "bot token" : null,
    !status.app_token_set ? "app token" : null,
    !status.channel_id ? "channel" : null,
  ].filter((v): v is string => !!v);
  if (missing.length > 0) return { label: "Slack", state: "missing", detail: missingDetail(missing) };
  if (status.runtime.running) {
    return { label: "Slack", state: "running", detail: `channel ${shortId(status.channel_id)}` };
  }
  if (status.runtime.last_error) {
    return {
      label: "Slack",
      state: "error",
      detail: compactError(status.runtime.last_error),
      title: status.runtime.last_error,
    };
  }
  return { label: "Slack", state: "stopped", detail: status.runtime.last_status ?? "not running" };
}

function subsidiaryDiscordConnection(
  subsidiary: SubsidiarySummary,
  headStatus: DiscordConfigStatus | null | undefined,
): PlatformConnection {
  if (subsidiary.platform !== "discord") return { label: "Discord", state: "disabled", detail: "not used" };
  if (!subsidiary.enabled) return { label: "Discord", state: "disabled", detail: "disabled" };
  if (headStatus === undefined) return { label: "Discord", state: "loading", detail: "checking head" };
  if (headStatus && !headStatus.runtime.embedded_enabled) {
    return { label: "Discord", state: "disabled", detail: "head embedded off" };
  }
  const missing = [
    headStatus === null ? "head status" : null,
    headStatus && !headStatus.token_set ? "head token" : null,
    !subsidiary.guild_id ? "guild" : null,
  ].filter((v): v is string => !!v);
  if (missing.length > 0) return { label: "Discord", state: "missing", detail: missingDetail(missing) };
  if (subsidiary.running) {
    return { label: "Discord", state: "running", detail: `guild ${shortId(subsidiary.guild_id)}` };
  }
  return { label: "Discord", state: "stopped", detail: "not running" };
}

function subsidiarySlackConnection(subsidiary: SubsidiarySummary): PlatformConnection {
  if (subsidiary.platform !== "slack") return { label: "Slack", state: "disabled", detail: "not used" };
  if (!subsidiary.enabled) return { label: "Slack", state: "disabled", detail: "disabled" };
  const missing = [
    !subsidiary.bot_token_set ? "bot token" : null,
    !subsidiary.app_token_set ? "app token" : null,
    !subsidiary.channel_id ? "channel" : null,
  ].filter((v): v is string => !!v);
  if (missing.length > 0) return { label: "Slack", state: "missing", detail: missingDetail(missing) };
  if (subsidiary.running) {
    return { label: "Slack", state: "running", detail: `channel ${shortId(subsidiary.channel_id)}` };
  }
  return { label: "Slack", state: "stopped", detail: "not running" };
}

function PlatformConnections({ items }: { items: PlatformConnection[] }) {
  return (
    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className={`min-w-0 rounded border px-2.5 py-2 text-xs ${connectionTone(item.state)}`}
          title={item.title ?? item.detail}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold shrink-0">{item.label}</span>
            <span className="ml-auto uppercase text-[10px] shrink-0">{item.state}</span>
          </div>
          <div className="mt-1 truncate text-[11px] opacity-90">{item.detail}</div>
        </div>
      ))}
    </div>
  );
}

export function OrganizationsSection({ active }: { active: SessionRow[] }) {
  const [subs, setSubs] = useState<SubsidiarySummary[] | null | undefined>(undefined);
  const [templates, setTemplates] = useState<DelegationTemplateLite[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [discordStatus, setDiscordStatus] = useState<DiscordConfigStatus | null | undefined>(undefined);
  const [slackStatus, setSlackStatus] = useState<SlackConfigStatus | null | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    const tick = () =>
      api.subsidiariesList()
        .then((r) => { if (!stopped) setSubs(r.subsidiaries); })
        .catch(() => { if (!stopped) setSubs(null); });
    void tick();
    const id = setInterval(tick, 8000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    api.delegationTemplates()
      .then((r) => setTemplates(r.templates.filter((t) => !t.call_only)))
      .catch(() => setTemplates([]));
    api.workRepos()
      .then((r) => setProjects(projectNames(r.repos)))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      void api.discordConfigGet()
        .then((status) => { if (!stopped) setDiscordStatus(status); })
        .catch(() => { if (!stopped) setDiscordStatus(null); });
      void api.slackConfigGet()
        .then((status) => { if (!stopped) setSlackStatus(status); })
        .catch(() => { if (!stopped) setSlackStatus(null); });
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  const headOfficeActive: SessionRow[] = [];
  const activeBySub = new Map<string, SessionRow[]>();
  for (const s of active) {
    const sid = (s.metadata as any)?.subsidiary_id;
    if (typeof sid === "string" && sid) {
      const rows = activeBySub.get(sid) ?? [];
      rows.push(s);
      activeBySub.set(sid, rows);
    } else {
      headOfficeActive.push(s);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-semibold">
          組織セッション
          <span className="text-subtle text-xs ml-2">
            本社 + {subs && subs.length > 0 ? subs.length : 0}
          </span>
        </h2>
        <Link to="/subsidiaries" className="text-xs text-accent ml-auto">管理 →</Link>
      </div>

      {subs === undefined && (
        <div className="text-subtle text-xs">子会社を読み込み中...</div>
      )}
      <div
        className="grid gap-4 items-start"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 720px), 720px))" }}
      >
        <OrganizationCard
          activeSessions={headOfficeActive}
          templates={templates}
          projects={projects}
          headDiscordStatus={discordStatus}
          headSlackStatus={slackStatus}
        />
        {(subs ?? []).map((s) => (
          <OrganizationCard
            key={s.id}
            subsidiary={s}
            activeSessions={activeBySub.get(s.id) ?? []}
            templates={templates}
            projects={projects}
            headDiscordStatus={discordStatus}
            headSlackStatus={slackStatus}
          />
        ))}
      </div>
    </section>
  );
}

function OrganizationCard({
  subsidiary,
  activeSessions,
  templates,
  projects,
  headDiscordStatus,
  headSlackStatus,
}: {
  subsidiary?: SubsidiarySummary;
  activeSessions: SessionRow[];
  templates: DelegationTemplateLite[];
  projects: string[];
  headDiscordStatus: DiscordConfigStatus | null | undefined;
  headSlackStatus: SlackConfigStatus | null | undefined;
}) {
  const isHeadOffice = !subsidiary;
  const budget = subsidiary?.daily_token_budget ?? 0;
  const used = subsidiary?.usage_today_tokens ?? 0;
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const deny = subsidiary?.requests_24h?.deny ?? 0;
  const allow = subsidiary?.requests_24h?.allow ?? 0;
  const locks = subsidiary?.lock_count ?? 0;
  const running = subsidiary?.running ?? true;
  const name = subsidiary ? (subsidiary.display_name || subsidiary.name) : "本社";
  const platform = subsidiary?.platform ?? "concordia";
  const connections = subsidiary
    ? [subsidiaryDiscordConnection(subsidiary, headDiscordStatus), subsidiarySlackConnection(subsidiary)]
    : [headDiscordConnection(headDiscordStatus), headSlackConnection(headSlackStatus)];
  return (
    <div className="bg-surface border border-border rounded p-4 md:p-5 hover:border-accent transition-colors w-full md:w-[720px] min-h-[520px] flex flex-col">
      <div className="flex items-center gap-2">
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${running ? "bg-ok" : "bg-subtle"}`}
          title={isHeadOffice ? "本社" : running ? "Bot 稼働中" : "Bot 停止"}
        />
        <span className="text-base font-medium truncate">{name}</span>
        <span className="text-subtle text-xs">/ {platform}</span>
        {subsidiary && !subsidiary.enabled && <span className="text-[10px] text-subtle ml-auto">無効</span>}
        {subsidiary && <Link to="/subsidiaries" className="text-[10px] text-accent ml-auto shrink-0">管理 →</Link>}
      </div>

      <div className="mt-3 flex items-center gap-3 text-sm">
        <span className={activeSessions.length > 0 ? "text-accent" : "text-subtle"}>
          active {activeSessions.length}
        </span>
        {locks > 0 && <span className="text-warn">🔒 {locks}</span>}
        {subsidiary && (
          <span className="ml-auto flex items-center gap-2">
            {deny > 0 && <span className="text-danger" title="直近 24h に deny した件数">deny {deny}</span>}
            {allow > 0 && <span className="text-subtle" title="直近 24h に allow した件数">allow {allow}</span>}
          </span>
        )}
      </div>

      <PlatformConnections items={connections} />

      {subsidiary && (
        <div className="mt-2 text-[11px]">
          <div className="flex items-center gap-1 text-subtle">
            <span className={subsidiary.budget_blocked ? "text-danger" : ""}>
              {subsidiary.budget_blocked ? "💸 " : ""}予算 {fmtTokens(used)}/{budget > 0 ? fmtTokens(budget) : "∞"}
            </span>
            {budget > 0 && <span className="ml-auto">{pct}%</span>}
          </div>
          {budget > 0 && (
            <div className="mt-1 h-1 bg-muted rounded overflow-hidden">
              <div
                className={`h-full ${subsidiary.budget_blocked || pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-accent"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      )}

      <DelegationSpawnForm
        subsidiaryId={subsidiary?.id ?? null}
        className="mt-4 pt-4 border-t border-border"
        templates={templates}
        projects={projects}
      />

      <div className="mt-4 pt-4 border-t border-border flex-1 min-h-[160px]">
        <div className="text-xs text-subtle mb-2">active sessions</div>
        <ActiveSessionRows rows={activeSessions} />
      </div>
    </div>
  );
}

function ActiveSessionRows({ rows }: { rows: SessionRow[] }) {
  if (rows.length === 0) return <div className="text-sm text-subtle">none</div>;
  const sorted = [...rows].sort((a, b) => b.last_seen_at - a.last_seen_at || a.id.localeCompare(b.id));
  return (
    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
      {sorted.map((s) => {
        const role = (s.metadata as any)?.role_label ?? s.provider;
        const project = (s.metadata as any)?.project;
        const targetProject = s.target_project?.trim();
        const lastUserMessage = (s as SessionRow & { last_user_message?: string | null }).last_user_message?.trim();
        return (
          <Link
            key={s.id}
            to={`/sessions/${encodeURIComponent(s.id)}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded px-2 py-2 text-sm hover:bg-muted"
            title={lastUserMessage || undefined}
          >
            <span className={`px-2 py-1 rounded text-xs ${statusBadge(s.status)}`}>{s.status}</span>
            <span className="font-mono truncate">{project ?? s.branch ?? s.repo_path}</span>
            <span className="text-subtle text-xs shrink-0">{s.id.slice(0, 8)}</span>
            <span className="col-start-2 col-span-2 text-xs text-subtle truncate">{role}</span>
            {targetProject && (
              <span className="col-start-2 col-span-2 text-xs text-subtle truncate">
                target {targetProject}
              </span>
            )}
            <span className="col-start-2 col-span-2">
              <SufficiencyBadges sufficiency={s.sufficiency} />
            </span>
            {lastUserMessage && (
              <span className="col-span-3 text-[13px] leading-snug text-text bg-muted/60 rounded px-2 py-1 line-clamp-2 break-words">
                {lastUserMessage}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

function projectNames(repos: Array<{ name: string }>): string[] {
  return [...new Set(repos.map((r) => r.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * Machines overview — aggregated active/lost/ended counts per host. Refreshes
 * on session.started / session.ended events so spawn + stop actions are
 * reflected without manual reload.
 */
