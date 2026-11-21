import { useEffect, useState } from "react";
import { mutate } from "./model.js";

type Target = { id: string; label: string; destination: string; gpu: string; maxSeconds: number; ready: boolean;
  transport?: "excubitor-site"; reason?: string | null };
type Run = {
  attemptId: string; targetId: string; providerTerminal: string; resourceRelease: string; qualityAcceptance: string;
  error: string | null; stopReason: string | null; deadlineAt: number;
  workerReport: { exitCode: number; tests?: { total: number; failed: number; skipped: number }; metrics?: Record<string, number> } | null;
  receipt?: { state: string; requestId?: string };
  sitePhase?: string | null; siteDeadlineAt?: number | null; stopProgress?: "none" | "requested" | "confirmed";
  canCollectSite?: boolean;
  artifactVerification: { checkpoints: Array<{ name: string; uri: string; sha256: string }>;
    siteFiles?: Array<{ name: string; bytes: number; sha256: string }> } | null;
};
const base = "/v1/delegation/cloud/colab";
const terminalLabel: Record<string, string> = {
  unknown: "確認中・不明", running: "実行中", succeeded: "正常終了", failed: "異常終了", cancelled: "停止",
};
const qualityLabel: Record<string, string> = { pending: "未検収", accepted: "合格", rejected: "不合格" };
const preflightRefusals = new Set(["cloud_colab_site_not_registered", "cloud_colab_site_mesh_not_ready", "cloud_colab_site_unreachable"]);
const siteReason: Record<string, string> = {
  cloud_colab_site_not_registered: "本社 Excubitor に拠点が登録されていません。",
  cloud_colab_site_mesh_not_ready: "拠点間の認証設定を確認してください。",
  cloud_colab_site_unreachable: "拠点に接続できません。Excubitor の接続と拠点間認証を確認してください。",
  cloud_colab_site_cli_unready: "拠点で Colab CLI のログインと接続を確認してください。",
  cloud_colab_site_busy: "拠点の同時実行枠が使用中です。",
  cloud_colab_site_program_mismatch: "拠点のプログラム ID、revision、SHA-256、GPU の登録を確認してください。",
  cloud_colab_site_start_refused: "拠点が開始を拒否しました。実行者、期限、拠点の設定を確認してください。",
  cloud_colab_credentials_unavailable: "成果を確認するための資格情報が設定されていません。",
  cloud_colab_site_submission_unknown: "拠点の受付結果が不明です。依頼を再送せず、所有者が拠点で冪等キーを照合してください。",
  cloud_colab_site_stop_unconfirmed: "拠点で停止を受け付けたか確認できません。状況を確認してください。",
  cloud_colab_site_observation_unavailable: "拠点の状況を取得できません。接続を確認してから状況を更新してください。",
};

export function CloudColabPanel({ sessionId, taskReference }: { sessionId: string; taskReference: string }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [targetId, setTargetId] = useState("");
  const [seconds, setSeconds] = useState(300);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attemptId, setAttemptId] = useState<string>();
  const [error, setError] = useState("");
  const target = targets.find(item => item.id === targetId);
  const query = `session_id=${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const options = { signal: controller.signal };
      const listed = await fetch(`${base}/runs?${query}`, options);
      if (listed.ok) setRuns((await listed.json() as { runs: Run[] }).runs);
      const response = await fetch(`${base}/targets?${query}`, options);
      if (response.ok) setTargets((await response.json() as { targets: Target[] }).targets);
    };
    void load().catch(() => { if (!controller.signal.aborted) setError("Colab の状態を取得できませんでした。"); });
    return () => controller.abort();
  }, [query]);

  async function refresh(observeSite = false) {
    const response = await fetch(`${base}/runs?${query}${observeSite ? "&refresh_site=1" : ""}`);
    if (!response.ok) throw new Error("Colab の状態を取得できませんでした。");
    setRuns((await response.json() as { runs: Run[] }).runs);
    if (observeSite) {
      const listed = await fetch(`${base}/targets?${query}`);
      if (listed.ok) setTargets((await listed.json() as { targets: Target[] }).targets);
    }
  }

  async function action(path: string, values: object) {
    setBusy(true); setError("");
    try {
      const response = await mutate("POST", base + path, { session_id: sessionId, ...values });
      if (!response.ok) {
        const detail = await response.json() as { error?: string };
        if (path === "/runs" && detail.error && preflightRefusals.has(detail.error)) {
          setAttemptId(undefined);
          setApproved(false);
        }
        throw new Error(detail.error ? siteReason[detail.error] ?? detail.error : "受付結果が不明です。状況を確認してください。");
      }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Colab の状態を確認してください。"); }
    finally { setBusy(false); }
  }

  if (!targets.length && !runs.length) return null;
  const unreleased = runs.some(run => run.resourceRelease !== "released");
  const active = runs.find(run => run.attemptId === attemptId);
  return <section className="border-t border-border pt-3 space-y-2" aria-label="本人同席の Colab 実行">
    <h3 className="font-medium">本人同席の Colab 実行</h3>
    <label className="block">登録済みの実行先 <select className="foundation-form" value={targetId} disabled={busy || !!attemptId}
      onChange={event => { setTargetId(event.target.value); setApproved(false); }}><option value="">実行先を選ぶ</option>
      {targets.map(item => <option key={item.id} value={item.id} disabled={!item.ready}>{item.label} · {item.gpu}
        {item.ready ? "" : item.transport ? " · 拠点の準備待ち" : " · OAuth 設定待ち"}</option>)}</select></label>
    {targets.filter(item => item.transport === "excubitor-site").map(item => <p key={item.id} role="status">
      {item.label} · {item.ready ? "拠点への接続を確認済み。Colab CLI は開始時に拠点で確認します。"
        : `拠点の準備待ち。${siteReason[item.reason ?? ""] ?? "拠点の設定を確認してください。"}`}
    </p>)}
    {target && <>
      <p>送信先 {target.destination} · GPU {target.gpu}</p>
      <label className="block">実行上限（秒） <input type="number" min={30} max={target.maxSeconds} value={seconds}
        disabled={busy || !!attemptId} onChange={event => setSeconds(event.target.valueAsNumber)} /></label>
      <label className="block"><input type="checkbox" checked={approved} disabled={busy || !!attemptId}
        onChange={event => setApproved(event.target.checked)} /> 公開コードと非機密データを表示の送信先で、本人が同席して実行する</label>
    </>}
    <button className="foundation-form" disabled={busy || unreleased || !!attemptId || !approved || !target?.ready
      || !Number.isInteger(seconds) || seconds < 30 || seconds > target.maxSeconds || !/^actio:[A-Za-z0-9-]+$/.test(taskReference)}
      onClick={() => {
        if (!target) return;
        const id = crypto.randomUUID();
        setAttemptId(id);
        void action("/runs", { targetId, attemptId: id, taskReference, seconds, ownerApproved: true,
          evidence: { code: "public", data: "non_confidential", destination: target.destination } });
      }}>Colab を開始</button>
    <button className="foundation-form" disabled={busy}
      onClick={() => void refresh(true).catch(cause => setError(cause.message))}>Colab の状況を確認</button>
    {attemptId && <p>依頼番号 {attemptId}</p>}
    {active?.resourceRelease === "released" && <button className="foundation-form" onClick={() => {
      setAttemptId(undefined); setApproved(false);
    }}>次の Colab 依頼</button>}
    {error && <p role="alert">{error}</p>}
    {runs.map(run => <article key={run.attemptId} className="border-t border-border py-2 space-y-2">
      <p>{run.targetId} · {run.attemptId}</p>
      <p>実行 {terminalLabel[run.providerTerminal]} · 成果 {run.artifactVerification ? "確認済み" : "未確認"} · 品質 {qualityLabel[run.qualityAcceptance]}
        {" · "}資源 {run.resourceRelease === "released" ? "解放済み" : "解放未確認"}</p>
      <p>停止期限 {new Date(run.siteDeadlineAt ?? run.deadlineAt).toLocaleString()}{run.stopReason ? ` · ${run.stopReason}` : ""}</p>
      {run.stopProgress === "requested" && <p role="status">{run.resourceRelease === "released"
        ? "資源の解放を確認しました。停止要求による終了は確認できていません。" : "停止を依頼済み。拠点による停止の確認を待っています。"}</p>}
      {run.stopProgress === "confirmed" && <p role="status">拠点で停止と解放を確認しました。</p>}
      {run.sitePhase === "release_unknown" && <p role="alert">ランタイムの解放を確認できません。実行枠を保持しています。所有者は Colab のランタイム管理画面を確認してください。</p>}
      {run.error && <p role="status">{siteReason[run.error] ?? run.error}</p>}
      {run.error === "cloud_colab_site_submission_unknown" && run.receipt?.requestId && <p>照合用の冪等キー {run.receipt.requestId}</p>}
      {run.workerReport && <p>終了コード {run.workerReport.exitCode}{run.workerReport.tests
        ? ` · テスト ${run.workerReport.tests.total} 件、失敗 ${run.workerReport.tests.failed} 件、スキップ ${run.workerReport.tests.skipped} 件` : ""}</p>}
      {run.workerReport?.metrics && <dl>{Object.entries(run.workerReport.metrics).map(([name, value]) => <div key={name}>
        <dt>{name}</dt><dd>{value}</dd>
      </div>)}</dl>}
      {run.artifactVerification?.checkpoints.map(file => <p key={file.name}><a className="underline" href={file.uri}>{file.name}</a> · SHA-256 {file.sha256}</p>)}
      {run.artifactVerification?.siteFiles?.map(file => <p key={file.name}>{file.name} · 拠点保管 · {file.bytes} バイト · SHA-256 {file.sha256}</p>)}
      {run.resourceRelease !== "released" && <button className="foundation-form" disabled={busy || !!run.stopReason || run.stopProgress === "requested"}
        onClick={() => void action(`/runs/${run.attemptId}/stop`, {})}>Colab の停止を依頼</button>}
      {(run.workerReport || run.canCollectSite) && !run.artifactVerification && run.resourceRelease === "released"
        && <button className="foundation-form" disabled={busy}
          onClick={() => void action(`/runs/${run.attemptId}/collect`, {})}>{run.canCollectSite ? "拠点の成果を確認" : "Drive の成果を再確認"}</button>}
      {run.artifactVerification && run.resourceRelease === "released" && run.qualityAcceptance === "pending" && <>
        <button className="foundation-form" disabled={busy} onClick={() => void action(`/runs/${run.attemptId}/quality`, { quality: "accepted" })}>成果を合格とする</button>
        <button className="foundation-form" disabled={busy} onClick={() => void action(`/runs/${run.attemptId}/quality`, { quality: "rejected" })}>成果を不合格とする</button>
      </>}
    </article>)}
  </section>;
}
