// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../../api.js";

import { TextSettingRow, putJson } from "./common.js";

// ─── Lictor 起動設定 (mode + dev/prod パス) ──────────────────────────────

export function LictorSection() {
  const [mode, setMode] = useState<string | null>(null);
  const [devPath, setDevPath] = useState<string | null>(null);
  const [prodExe, setProdExe] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const s = (await fetch("/v1/admin/lictor").then((r) => r.json())) as {
        lictor_mode: string; lictor_dev_path: string; lictor_prod_exe: string;
      };
      setMode(s.lictor_mode);
      setDevPath(s.lictor_dev_path);
      setProdExe(s.lictor_prod_exe);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply(body: unknown, key: string) {
    setBusy(key); setError(null);
    try { await putJson("/v1/admin/lictor", body); await refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">Lictor 起動設定</h2>
        <p className="text-subtle text-xs mt-0.5">
          spawn が Lictor をどう起動するか。 auto = PATH 上の <code>lictor</code> (従来)、
          dev = ローカルリポを <code>node bin/lictor.mjs</code> で実行、 prod = 同梱 exe を直接実行。
          PATH に lictor が無く spawn に失敗する環境向け。
        </p>
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="text-sm font-medium">モード</div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0">現在:</span>
          <span className="shrink-0 px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">
            {mode ?? "..."}
          </span>
          <select
            value={mode ?? "auto"} onChange={(e) => apply({ lictor_mode: e.target.value }, "mode")}
            disabled={busy === "mode"}
            className="bg-muted border border-border rounded px-2 py-1 text-sm ml-auto"
          >
            <option value="auto">auto (PATH の lictor)</option>
            <option value="dev">dev (ローカルリポ)</option>
            <option value="prod">prod (同梱 exe)</option>
          </select>
        </div>
      </div>

      <TextSettingRow
        label="dev リポパス"
        hint={<>dev モードで使う Lictor リポ root。 <code>node &lt;path&gt;\bin\lictor.mjs</code> を起動。</>}
        current={devPath} placeholder="E:\\Document\\Ars\\Lictor" busy={busy === "dev"}
        onApply={(v) => apply({ lictor_dev_path: v }, "dev")}
      />
      <TextSettingRow
        label="prod exe パス"
        hint={<>prod モードで使う同梱 Lictor exe (Release 公開物) の絶対パス。</>}
        current={prodExe} placeholder="C:\\path\\to\\lictor.exe" busy={busy === "prod"}
        onApply={(v) => apply({ lictor_prod_exe: v }, "prod")}
      />
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
