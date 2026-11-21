import { useEffect, useState } from "react";
import { mutate } from "./model.js";

interface Runner { id: string; destination: string; inputKeys: string[]; maxSeconds: number; ready: boolean }
interface Target { id: string; name: string; kind: string; runners: Runner[] }
interface Request {
  attemptId: string; taskReference: string; targetId: string; runner: string; deadline: string;
  inputs: Record<string, string>; evidence: { code: "public"; data: "non_confidential"; destination: string };
}
interface Run {
  attemptId: string; targetId: string; runner: string; submission: string; providerState: string | null;
  deadline: string; exitCode: number | null; resourceRelease: string; stopProgress: string; providerTerminal: string;
  artifactCollectionConfigured: boolean; qualityAcceptance: string; issue: string | null;
  artifactVerification: Array<{ name: string; uri: string; sha256: string }> | null;
  receipt: { operationId?: string };
}
type Proposal = Request & { expiresAt: number };

const base = "/v1/delegation/cloud/aws";
const taskRef = /^actio:[A-Za-z0-9-]+$/;
const rejectedBeforeStart = new Set(["cloud_aws_busy", "cloud_aws_classification", "cloud_aws_deadline", "cloud_aws_duplicate_request",
  "cloud_aws_invalid_inputs", "cloud_aws_proposal_expired", "cloud_aws_usage", "cloud_budget_exhausted",
  "cloud_company_capacity_exhausted", "cloud_pending_human_question", "cloud_target_not_found"]);
const submissionLabels: Record<string, string> = {
  unknown: "受付未確認", queued: "投入待ち", submitting: "投入中", accepted: "投入済み",
  rejected: "投入失敗", discarded: "投入前に停止", refused: "受付拒否",
};
const resultLabels: Record<string, string> = {
  unknown: "未確認", running: "実行中", succeeded: "正常終了", failed: "異常終了", cancelled: "停止済み",
};

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + path, { signal });
  if (!response.ok) throw new Error("AWS の情報を取得できませんでした。");
  return response.json() as Promise<T>;
}

export function CloudAwsPanel({ sessionId, taskReference }: { sessionId: string; taskReference: string }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [targetId, setTargetId] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [seconds, setSeconds] = useState(300);
  const [approved, setApproved] = useState(false);
  const [proposalId, setProposalId] = useState("");
  const [pending, setPending] = useState<{ request: Request; proposal: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = "?session_id=" + encodeURIComponent(sessionId);
  const target = targets.find(item => item.id === targetId);
  const runner = target?.runners.find(item => item.id === runnerId);
  const chosenProposal = proposals.find(item => item.attemptId === proposalId);
  const pendingRun = pending && runs.find(run => run.attemptId === pending.request.attemptId);

  useEffect(() => {
    const controller = new AbortController();
    const report = (cause: Error) => { if (!controller.signal.aborted) setError(cause.message); };
    async function load() {
      const signal = controller.signal;
      // The authenticated proposal endpoint also distinguishes browser access from loopback MCP.
      const access = await fetch(base + "/proposals" + query, { signal });
      if (access.status === 403 || access.status === 404) return;
      if (!access.ok) throw new Error("AWS の情報を取得できませんでした。");
      setProposals((await access.json() as { proposals: Proposal[] }).proposals);
      await Promise.all([
        read<{ targets: Target[] }>("/targets" + query, signal).then(body => setTargets(body.targets)),
        read<{ runs: Run[] }>("/runs" + query, signal).then(body => setRuns(body.runs)),
      ]);
    }
    void load().catch(report);
    return () => controller.abort();
  }, [query]);

  function updateRun(run: Run) {
    setRuns(previous => previous.some(item => item.attemptId === run.attemptId)
      ? previous.map(item => item.attemptId === run.attemptId ? run : item) : [run, ...previous]);
  }

  async function action(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "AWS の状態を確認してください。"); }
    finally { setBusy(false); }
  }

  async function post(path: string, body: object) {
    const response = await mutate("POST", base + path, { session_id: sessionId, ...body });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(detail.error ?? "受付結果を確認できませんでした。同じ依頼番号で状況を確認してください。");
    }
    updateRun(await response.json() as Run);
  }

  function send(request: Request, proposal = false) {
    setPending({ request, proposal });
    void action(async () => {
      await post("/runs", { ...request, ownerApproved: true, ...(proposal ? { proposal: true } : {}) });
      setProposals(previous => previous.filter(item => item.attemptId !== request.attemptId));
      setProposalId("");
      setApproved(false);
    });
  }

  if (!targets.length && !runs.length && !proposals.length && !error) return null;
  function resetApproval() { setApproved(false); setInputs({}); }
  async function refresh() {
    const [listed, draftList] = await Promise.all([
      read<{ runs: Run[] }>("/runs" + query),
      read<{ proposals: Proposal[] }>("/proposals" + query).catch(() => ({ proposals: [] })),
    ]);
    setRuns(listed.runs);
    setProposals(draftList.proposals);
  }
  function approve() {
    if (chosenProposal) {
      const { expiresAt: _expiresAt, ...request } = chosenProposal;
      send(request, true);
    } else if (runner) {
      send({ attemptId: crypto.randomUUID(), targetId, runner: runner.id, taskReference, inputs,
        deadline: new Date(Date.now() + seconds * 1000).toISOString(),
        evidence: { code: "public", data: "non_confidential", destination: runner.destination } });
    }
  }
  const ready = chosenProposal ? chosenProposal.expiresAt > Date.now()
    : !!runner?.ready && taskRef.test(taskReference) && Number.isInteger(seconds) && seconds > 0 && seconds <= runner.maxSeconds;

  return <section className="border-t border-border pt-3 space-y-2" aria-label="AWS 計算">
    <h3 className="font-medium">AWS 計算</h3>
    {!!proposals.length && <label className="block">MCP 開始案 <select className="foundation-form" value={proposalId}
      disabled={busy || !!pending} onChange={event => { setProposalId(event.target.value); resetApproval(); }}>
      <option value="">手動で入力</option>
      {proposals.map(proposal => <option value={proposal.attemptId} key={proposal.attemptId}>
        {proposal.targetId} · {proposal.runner} · {proposal.attemptId}
      </option>)}
    </select></label>}
    {chosenProposal ? <div className="space-y-1">
      <p>{chosenProposal.targetId} · {chosenProposal.runner} · {chosenProposal.taskReference}</p>
      <p>送信先 {chosenProposal.evidence.destination} · 期限 {new Date(chosenProposal.deadline).toLocaleString()}</p>
      <dl>{Object.entries(chosenProposal.inputs).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    </div> : <>
      <label className="block">AWS 実行先 <select className="foundation-form" value={targetId} disabled={busy || !!pending}
        onChange={event => { setTargetId(event.target.value); setRunnerId(""); resetApproval(); }}>
        <option value="">実行先を選ぶ</option>
        {targets.map(item => <option value={item.id} key={item.id}>{item.name} · {item.kind === "ec2" ? "EC2" : "Fargate"}</option>)}
      </select></label>
      {target && <label className="block">Runner <select className="foundation-form" value={runnerId} disabled={busy || !!pending}
        onChange={event => { setRunnerId(event.target.value); resetApproval(); }}>
        <option value="">Runner を選ぶ</option>
        {target.runners.map(item => <option value={item.id} key={item.id} disabled={!item.ready}>
          {item.id}{item.ready ? "" : " · 設定待ち"}
        </option>)}
      </select></label>}
      {runner && <>
        <p>送信先 {runner.destination}</p>
        <label className="block">実行上限（秒） <input type="number" min={1} max={runner.maxSeconds}
          value={seconds} disabled={busy || !!pending}
          onChange={event => { setSeconds(event.target.valueAsNumber); setApproved(false); }} /></label>
        {runner.inputKeys.map(key => <label key={key} className="block">{key} <input className="foundation-form"
          maxLength={512} value={inputs[key] ?? ""} disabled={busy || !!pending}
          onChange={event => { setInputs({ ...inputs, [key]: event.target.value }); setApproved(false); }} /></label>)}
      </>}
    </>}
    {(runner || chosenProposal) && <label className="block"><input type="checkbox" checked={approved} disabled={busy || !!pending}
      onChange={event => setApproved(event.target.checked)} /> 公開コードと非機密入力を、表示された送信先で実行する</label>}
    <button className="foundation-form" disabled={busy || !!pending || !approved || !ready} onClick={approve}>AWS を開始</button>
    <button className="foundation-form" disabled={busy} onClick={() => void action(refresh)}>AWS の一覧を更新</button>
    {pending && <p>依頼番号 {pending.request.attemptId}</p>}
    {pending && !pendingRun && (rejectedBeforeStart.has(error)
      ? <button className="foundation-form" disabled={busy} onClick={() => {
        setPending(undefined); setProposalId(""); resetApproval();
      }}>入力を見直す</button>
      : <button className="foundation-form" disabled={busy}
        onClick={() => send(pending.request, pending.proposal)}>同じ依頼番号で受付を確認</button>)}
    {pendingRun?.resourceRelease === "released" && <button className="foundation-form" disabled={busy}
      onClick={() => { setPending(undefined); resetApproval(); }}>次の AWS 依頼</button>}
    {error && <p role="alert">{error}</p>}
    {runs.map(run => <article className="border-t border-border py-2 space-y-1" key={run.attemptId}>
      <p>{run.targetId} · {run.runner} · {run.attemptId}</p>
      <p>{submissionLabels[run.submission]} · 実行 {resultLabels[run.providerTerminal]}
        {run.providerState ? ` (${run.providerState})` : ""} · 資源 {run.resourceRelease === "released" ? "解放済み" : "解放未確認"}</p>
      <p>期限 {new Date(run.deadline).toLocaleString()}
        {run.stopProgress !== "none" ? ` · ${run.stopProgress === "confirmed" ? "停止確認済み" : "停止要求中"}` : ""}</p>
      {run.receipt.operationId && <p>Excubitor 操作 ID {run.receipt.operationId}</p>}
      {run.exitCode !== null && <p>終了コード {run.exitCode}</p>}
      {run.issue && <p role="status">{run.issue}</p>}
      {run.artifactVerification?.map(file => <p key={file.name}><a className="underline" href={file.uri}>{file.name}</a> · SHA-256 {file.sha256}</p>)}
      {run.artifactVerification && <p>検収 {run.qualityAcceptance === "accepted" ? "合格" : run.qualityAcceptance === "rejected" ? "不合格" : "未検収"}</p>}
      <button className="foundation-form" disabled={busy} onClick={() => void action(async () => {
        updateRun(await read<Run>(`/runs/${run.attemptId}${query}`));
      })}>AWS の状況を確認</button>
      {run.resourceRelease !== "released" && <button className="foundation-form" disabled={busy}
        onClick={() => void action(() => post(`/runs/${run.attemptId}/stop`, {}))}>AWS の停止を依頼</button>}
      {run.resourceRelease === "released" && run.artifactCollectionConfigured && !run.artifactVerification
        && <button className="foundation-form" disabled={busy}
          onClick={() => void action(() => post(`/runs/${run.attemptId}/collect`, {}))}>Drive の成果を確認</button>}
      {run.artifactVerification && run.qualityAcceptance === "pending" && <>
        <button className="foundation-form" disabled={busy}
          onClick={() => void action(() => post(`/runs/${run.attemptId}/quality`, { quality: "accepted" }))}>成果を合格とする</button>
        <button className="foundation-form" disabled={busy}
          onClick={() => void action(() => post(`/runs/${run.attemptId}/quality`, { quality: "rejected" }))}>成果を不合格とする</button>
      </>}
    </article>)}
  </section>;
}
