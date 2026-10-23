import { useEffect, useState } from "react";
import { mutate } from "./model.js";

type SiteTemplate = { id: string; call_name: string; title: string; template_active: boolean; exception: boolean | null; effective_active: boolean };
type SiteState = { site: string; default_active: boolean; default_configured: boolean; templates: SiteTemplate[] };
const base = "/v1/delegation/site-category-defaults";

/** @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS */
async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

/**
 * 拠点のパートタイマー: 既定 (オン/オフ) と、気に入ったものだけの個別オン/オフ。
 *
 * @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS
 */
export function SiteParttimers() {
  const [site, setSite] = useState("");
  const [state, setState] = useState<SiteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 既定はこの Concordia の拠点 ID。 本社では空のまま、 管理したい拠点 ID を入れる。
  useEffect(() => {
    const controller = new AbortController();
    void readJson<{ siteId?: string | null }>("/v1/federation/site", controller.signal)
      .then((value) => { if (value.siteId) setSite(value.siteId); })
      .catch(() => { /* 拠点設定が無い Concordia では手入力 */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(site)) { setState(null); return; }
    const controller = new AbortController();
    setError(null);
    void readJson<SiteState>(`${base}/${site}/parttimer`, controller.signal)
      .then(setState)
      .catch((err: unknown) => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [site]);

  /** @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS */
  async function put(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await mutate("PUT", `${base}/${site}/parttimer${path}`, body);
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      setState(await readJson<SiteState>(`${base}/${site}/parttimer`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-border bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">拠点のパートタイマー</h2>
        <label className="text-sm text-subtle flex items-center gap-1">
          拠点 ID
          <input aria-label="拠点 ID" className="foundation-form px-2 py-1" value={site} onChange={(e) => setSite(e.target.value.trim())} placeholder="melpot" />
        </label>
      </div>
      <p className="text-subtle text-sm">
        拠点ではパートタイマーを既定で動かしません。使いたいものだけ「オン」にしてください。
        既定そのものを変えると、個別に決めていないパートタイマーがまとめて切り替わります。
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {state && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>この拠点の既定: <strong>{state.default_active ? "オン" : "オフ"}</strong>{state.default_configured ? "" : " (組み込み既定)"}</span>
            <button type="button" className="px-2 py-1 border rounded" disabled={busy} onClick={() => void put("", { is_active: !state.default_active })}>
              既定を{state.default_active ? "オフ" : "オン"}にする
            </button>
            {state.default_configured && (
              <button type="button" className="px-2 py-1 border rounded" disabled={busy} onClick={() => void put("", { is_active: null })}>組み込み既定に戻す</button>
            )}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-subtle"><th>パートタイマー</th><th>個別設定</th><th>実際</th></tr></thead>
            <tbody>
              {state.templates.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="py-1"><div>{t.title}</div><div className="text-xs text-subtle">{t.call_name}{t.template_active ? "" : " (テンプレ自体が無効)"}</div></td>
                  <td>
                    <select aria-label={`${t.call_name} の個別設定`} className="foundation-form px-2 py-1" disabled={busy}
                      value={t.exception === null ? "default" : t.exception ? "on" : "off"}
                      onChange={(e) => void put(`/templates/${encodeURIComponent(t.id)}`, { enabled: e.target.value === "default" ? null : e.target.value === "on" })}>
                      <option value="default">既定に従う</option>
                      <option value="on">オン</option>
                      <option value="off">オフ</option>
                    </select>
                  </td>
                  <td>{t.effective_active ? "動く" : "動かない"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
