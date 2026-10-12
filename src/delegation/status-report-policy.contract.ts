/** @implements spec/feature/delegation.md#状態照会と終端報告の分離 — 照会ビューの observe 契約 (dsr-C-1) */
interface Run { id: string; status: string; prompt_file_path?: string | null }

export default {
  post(result: unknown, run: Run): boolean {
    if (!result || typeof result !== "object") return false;
    const view = result as { run_id?: unknown; status?: unknown; terminal?: unknown; correctable?: unknown };
    const terminal = run.status === "completed" || run.status === "failed";
    return view.run_id === run.id
      && view.status === run.status
      && view.terminal === terminal
      && view.correctable === !terminal;
  },
};
