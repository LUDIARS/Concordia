// @implements SPEC-BOUNTY-WEBUI
import { useEffect, useState } from "react";

import { api } from "../api.js";

// Cocoiru の報告フォームが Cc を呼ぶときの鍵 (CC-BOUNTY-INV-10)。 暗号化して保存し、値は画面に戻さない。
// env からは読まない。 Discord Bot の内部トークンは Cc が起動時に作るので設定は要らない。

export function BountyCocoiruKey() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.bountyCocoiruKeyStatus().then((r) => setConfigured(r.configured)).catch(() => setConfigured(null));
  }, []);

  const save = async (value: string | null) => {
    try {
      const result = await api.bountySetCocoiruKey(value);
      setConfigured(result.configured);
      setKey("");
      setMessage(value ? "Cocoiru の鍵を保存しました。" : "Cocoiru の鍵を消しました。");
    } catch (e) {
      setMessage(`保存できませんでした: ${(e as Error).message}`);
    }
  };

  return (
    <section className="border border-border rounded p-3 space-y-2 text-sm">
      <h2 className="font-semibold">Cocoiru の鍵</h2>
      <p className="text-xs text-subtle">
        Cocoiru が人の名前でバグを報告するときに付ける鍵です (16 文字以上)。未設定の間、Cocoiru からの報告は 403 になります。
        状態: {configured === null ? "不明" : configured ? "設定済み" : "未設定"}
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        <input type="password" autoComplete="off" className="foundation-form text-xs flex-1 min-w-48" placeholder="新しい鍵"
          value={key} onChange={(e) => setKey(e.target.value)} />
        <button type="button" className="px-2 py-1 rounded border border-border disabled:opacity-50" disabled={key.trim().length < 16}
          onClick={() => void save(key.trim())}>保存</button>
        <button type="button" className="px-2 py-1 rounded border border-border disabled:opacity-50" disabled={!configured}
          onClick={() => void save(null)}>消去</button>
      </div>
      {message && <div className="text-xs">{message}</div>}
    </section>
  );
}
