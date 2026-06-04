import { Route, Routes } from "react-router-dom";
import { Nav, type NavItem } from "./components/Nav.js";
import { Monitor } from "./pages/Monitor.js";
import { Work } from "./pages/Work.js";
import { SessionDetail } from "./pages/SessionDetail.js";
import { Chat } from "./pages/Chat.js";
import { WorldChat } from "./pages/WorldChat.js";
import { ReportView } from "./pages/ReportView.js";
import { Reports } from "./pages/Reports.js";
import { Setup } from "./pages/Setup.js";
import { Skills } from "./pages/Skills.js";
import { Rules } from "./pages/Rules.js";
import { Personas } from "./pages/Personas.js";
import { Delegation } from "./pages/Delegation.js";
import { Settings } from "./pages/Settings.js";
import { PrQueue } from "./pages/PrQueue.js";

const NAV: NavItem[] = [
  { to: "/", label: "Monitor" },
  { to: "/work", label: "Work" },
  { to: "/prs", label: "PRs" },
  { to: "/world", label: "World" },
  { to: "/chat", label: "Chat" },
  { to: "/personas", label: "Personas" },
  { to: "/reports", label: "Reports" },
  { to: "/skills", label: "Skills" },
  { to: "/rules", label: "Rules" },
  { to: "/delegation", label: "Delegation" },
  { to: "/setup", label: "Setup" },
  { to: "/settings", label: "設定" },
];

export function App() {
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-border bg-surface px-3 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-lg font-semibold whitespace-nowrap">
          <span className="text-accent">●</span> Concordia
        </span>
        <span className="text-subtle text-xs hidden md:inline">multi-agent session coordinator</span>
        <Nav items={NAV} />
      </header>

      <main className="flex-1 px-3 sm:px-6 py-4">
        <Routes>
          <Route path="/" element={<Monitor />} />
          <Route path="/work" element={<Work />} />
          <Route path="/prs" element={<PrQueue />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/world" element={<WorldChat />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/:id" element={<ReportView />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/personas" element={<Personas />} />
          <Route path="/delegation" element={<Delegation />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <footer className="border-t border-border bg-surface px-3 sm:px-6 py-2 text-xs text-subtle">
        <a href="https://github.com/LUDIARS/Concordia" target="_blank" rel="noreferrer">
          LUDIARS/Concordia
        </a>
        {" · "}loopback 17330
      </footer>
    </div>
  );
}
