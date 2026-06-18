import { useState } from "react";
import { SlackSettingsSection } from "./SlackConfig.js";
import { DiscordSettingsSection } from "./DiscordConfig.js";
import { ModelCatalogSection } from "./ModelCatalog.js";
import {
  RuntimeControlsSection,
  ReactionWorkflowSection,
  WorkspaceSection,
  CostBudgetSection,
  LictorSection,
  WebHostsSection,
} from "./settings/sections.js";

// Concordia の「設定」ページ。 設定項目が増えたので左メニュー + セクション構成にした。
// 連携 (Slack/Discord) / モデル / ランタイム制御 / リアクションWF / ワークスペース / Lictor。
// ランタイム kill switch は旧 Rules ページから移設 (Rules はルール CRUD 専用に)。

interface SettingsSection {
  id: string;
  label: string;
  hint: string;
  render: () => React.ReactNode;
}

const SECTIONS: SettingsSection[] = [
  {
    id: "integrations",
    label: "連携",
    hint: "Slack / Discord (DB+暗号化、 token は hot 再接続)",
    render: () => (
      <div className="space-y-6">
        <section className="border border-border rounded p-4"><SlackSettingsSection /></section>
        <section className="border border-border rounded p-4"><DiscordSettingsSection /></section>
      </div>
    ),
  },
  {
    id: "models",
    label: "モデル",
    hint: "delegation / report で使うモデルカタログ",
    render: () => <section className="border border-border rounded p-4"><ModelCatalogSection /></section>,
  },
  {
    id: "runtime",
    label: "ランタイム制御",
    hint: "chat-mute / rules-enabled / proposer / Discord bot",
    render: () => <section className="border border-border rounded p-4"><RuntimeControlsSection /></section>,
  },
  {
    id: "reaction",
    label: "リアクションWF",
    hint: "ON/OFF + 絵文字→アクション マッピング",
    render: () => <section className="border border-border rounded p-4"><ReactionWorkflowSection /></section>,
  },
  {
    id: "workspace",
    label: "ワークスペース",
    hint: "ワークスペースルート / GitHub Organization",
    render: () => <section className="border border-border rounded p-4"><WorkspaceSection /></section>,
  },
  {
    id: "cost",
    label: "コスト予算",
    hint: "日次トークン上限 + 超過で命令ブロック",
    render: () => <section className="border border-border rounded p-4"><CostBudgetSection /></section>,
  },
  {
    id: "lictor",
    label: "Lictor",
    hint: "spawn の Lictor 起動 (auto / dev / prod)",
    render: () => <section className="border border-border rounded p-4"><LictorSection /></section>,
  },
  {
    id: "web-hosts",
    label: "Web ホスト",
    hint: "Vite allowedHosts (Tunnel / Tailscale 等の外部ホスト名)",
    render: () => <section className="border border-border rounded p-4"><WebHostsSection /></section>,
  },
];

export function Settings() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const current = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold">設定</h1>
        <p className="text-subtle text-sm mt-1">
          サービス内で変更できる設定. 多くは保存時に即時反映 (一部はワークスペースルート等 bot 再起動で反映).
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
        <nav className="space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={
                "w-full text-left px-3 py-2 rounded border text-sm " +
                (s.id === active
                  ? "bg-accent/15 border-accent text-accent"
                  : "bg-surface border-border text-text hover:border-accent/50")
              }
            >
              <div className="font-medium">{s.label}</div>
              <div className="text-[11px] text-subtle mt-0.5 leading-tight">{s.hint}</div>
            </button>
          ))}
        </nav>

        <div className="min-w-0">{current.render()}</div>
      </div>
    </div>
  );
}
