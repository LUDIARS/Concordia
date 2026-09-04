// Lictor 起動設定の表示。
//
// mode / dev パス / prod exe の 3 項目は設定レジストリ
// (`runtime.lictor_mode` / `runtime.lictor_dev_path` / `runtime.lictor_prod_exe`) に
// `editable: true` で載っており、「すべて」タブから編集できる。 ここにも編集欄を
// 置くと **同じ DB キーを 2 つの経路 (`/v1/admin/lictor` とレジストリ) から書ける**
// 状態になり、 どちらが正なのか画面から判らなくなる。 そのため本セクションは
// 現在値の表示と、 編集先への導線だけを持つ。

import { useEffect, useState } from "react";

/** @implements spec/tasks/2026-08-09-settings-duplicate-display-cleanup.md */
export function LictorSection({ onOpenAllSettings }: { onOpenAllSettings: () => void }) {
  const [mode, setMode] = useState<string | null>(null);
  const [devPath, setDevPath] = useState<string | null>(null);
  const [prodExe, setProdExe] = useState<string | null>(null);
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

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2 text-sm">
        <ReadOnlyRow label="モード" value={mode} mono />
        <ReadOnlyRow label="dev リポパス" value={devPath} />
        <ReadOnlyRow label="prod exe パス" value={prodExe} />
      </div>

      <p className="text-subtle text-xs">
        値の編集は <strong>設定 &gt; すべて</strong> で行う
        (<code>runtime.lictor_mode</code> / <code>runtime.lictor_dev_path</code> /
        <code>runtime.lictor_prod_exe</code>)。
        {" "}
        <button
          type="button"
          onClick={onOpenAllSettings}
          className="underline text-accent hover:text-accent/80"
        >
          すべての設定を開く
        </button>
      </p>

      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}

/** @implements spec/tasks/2026-08-09-settings-duplicate-display-cleanup.md */
function ReadOnlyRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-xs text-subtle shrink-0 w-28">{label}</span>
      <span className={"break-all " + (mono ? "font-mono text-xs px-2 py-0.5 rounded border bg-ok/20 border-ok text-ok" : "text-xs")}>
        {value === null ? "..." : value === "" ? "(未設定)" : value}
      </span>
    </div>
  );
}
