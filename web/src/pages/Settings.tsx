import { Link } from "react-router-dom";
import { SlackSettingsSection } from "./SlackConfig.js";
import { DiscordSettingsSection } from "./DiscordConfig.js";
import { ModelCatalogSection } from "./ModelCatalog.js";

// Concordia の「設定」ページ。サービス内で変更できる連携設定をここに集約する。
// 現状: Slack 連携 / Discord 連携 (どちらも DB+暗号化、 token は hot 再接続)。
// ランタイム kill switch (chat-mute / rules-enabled / proposer 間隔) は Rules ページ。

export function Settings() {
  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">設定</h1>
        <p className="text-subtle text-sm mt-1">
          サービス内で変更できる連携設定. 変更は保存した時点で反映されます (再起動不要).
        </p>
      </header>

      <section className="border border-border rounded p-4">
        <SlackSettingsSection />
      </section>

      <section className="border border-border rounded p-4">
        <DiscordSettingsSection />
      </section>

      <section className="border border-border rounded p-4">
        <ModelCatalogSection />
      </section>

      <section className="bg-surface border border-border rounded p-4 text-xs text-subtle">
        <h2 className="font-semibold text-text mb-1">その他の設定</h2>
        <p>
          ランタイムの kill switch (チャット mute / ルール有効化 / proposer 間隔) は
          <Link to="/rules" className="text-accent"> Rules</Link> ページにあります.
          skill / hook の導入は <Link to="/setup" className="text-accent">Setup</Link> ページ.
        </p>
      </section>
    </div>
  );
}
