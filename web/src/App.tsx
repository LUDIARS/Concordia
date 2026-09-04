import { Route, Routes } from "react-router-dom";
import { Nav, type NavItem } from "./components/Nav.js";
import { Monitor } from "./pages/Monitor.js";
import { Work } from "./pages/Work.js";
import { SessionChat } from "./pages/session-chat/SessionChat.js";
import { SessionLogs as SessionLogDetail } from "./pages/session-logs/SessionLogs.js";
import { Sessions } from "./pages/Sessions.js";
import { ReportView } from "./pages/ReportView.js";
import { Reports } from "./pages/Reports.js";
import { SessionLogs } from "./pages/SessionLogs.js";
import { WsCleanup } from "./pages/WsCleanup.js";
import { Library } from "./pages/Library.js";
import { Setup } from "./pages/Setup.js";
import { Skills } from "./pages/Skills.js";
import { Delegation } from "./pages/Delegation.js";
import { Staff } from "./pages/Staff.js";
import { Manuals } from "./pages/Manuals.js";
import { Subsidiaries } from "./pages/Subsidiaries.js";
import { Settings } from "./pages/Settings.js";
import { PrQueue } from "./pages/PrQueue.js";
import { Inbox } from "./pages/Inbox.js";
import { CostFeed } from "./pages/CostFeed.js";
import { Federation } from "./pages/Federation.js";
import { Taskflow } from "./pages/Taskflow.js";
import { RuntimeVersion } from "./components/RuntimeVersion.js";
import { Teams } from "./pages/Teams.js";
import { ProjectCodes } from "./pages/ProjectCodes.js";
import { TeamFilterProvider, TeamSelect } from "./lib/TeamFilterContext.js";

const NAV: NavItem[] = [
  { to: "/inbox", label: "未回答", section: "チーム" },
  { to: "/teams", label: "Teams", section: "チーム" },
  { to: "/", label: "Monitor", section: "チーム" },
  { to: "/work", label: "Work", section: "チーム" },
  { to: "/taskflow", label: "Taskflow", section: "チーム" },
  { to: "/staff", label: "社員", section: "チーム" },
  { to: "/subsidiaries", label: "子会社", section: "チーム" },
  { to: "/prs", label: "PRs", section: "レビュー・PR" },
  { to: "/reports", label: "Reports", section: "レビュー・PR" },
  { to: "/delegation", label: "Delegation", section: "レビュー・PR" },
  { to: "/cost", label: "Cost", section: "運用" },
  { to: "/session-logs", label: "作業ログ", section: "運用" },
  { to: "/ws-cleanup", label: "整理", section: "運用" },
  { to: "/library", label: "記憶整理", section: "運用" },
  { to: "/federation", label: "拠点", section: "運用" },
  { to: "/projects", label: "プロジェクト", section: "設定" },
  { to: "/skills", label: "Skills", section: "設定" },
  { to: "/manuals", label: "マニュアル", section: "設定" },
  { to: "/setup", label: "Setup", section: "設定" },
  { to: "/settings", label: "設定", section: "設定" },
];

export function App() {
  return (
    <TeamFilterProvider>
    <div className="min-h-full flex flex-col">
      <header className="border-b border-border bg-surface px-3 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-lg font-semibold whitespace-nowrap">
          <span className="text-accent">●</span> Concordia
        </span>
        <RuntimeVersion />
        <span className="text-subtle text-xs hidden md:inline">multi-agent session coordinator</span>
        <span className="ml-auto"><TeamSelect /></span>
      </header>
      <div className="flex min-h-0 flex-1">
        <Nav items={NAV} />
      <main className="min-w-0 flex-1 px-3 sm:px-6 py-4">
        <Routes>
          <Route path="/" element={<Monitor />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/work" element={<Work />} />
          <Route path="/taskflow" element={<Taskflow />} />
          <Route path="/prs" element={<PrQueue />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id/logs" element={<SessionLogDetail />} />
          <Route path="/sessions/:id" element={<SessionChat />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/:id" element={<ReportView />} />
          <Route path="/session-logs" element={<SessionLogs />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/cost" element={<CostFeed />} />
          <Route path="/ws-cleanup" element={<WsCleanup />} />
          <Route path="/library" element={<Library />} />
          <Route path="/delegation" element={<Delegation />} />
          <Route path="/manuals" element={<Manuals />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/subsidiaries" element={<Subsidiaries />} />
          <Route path="/federation" element={<Federation />} />
          <Route path="/projects" element={<ProjectCodes />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      </div>

      <footer className="border-t border-border bg-surface px-3 sm:px-6 py-2 text-xs text-subtle">
        <a href="https://github.com/LUDIARS/Concordia" target="_blank" rel="noreferrer">
          LUDIARS/Concordia
        </a>
        {" · "}loopback 11111
      </footer>
    </div>
    </TeamFilterProvider>
  );
}
