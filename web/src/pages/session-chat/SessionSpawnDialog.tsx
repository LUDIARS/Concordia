import { useEffect, useRef } from "react";
import { DelegationSpawnForm } from "../../components/DelegationSpawnForm.js";

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
export function SessionSpawnDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  return (
    <dialog ref={dialog} onClose={onClose} aria-label="新規セッション"
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded border border-border bg-surface p-4 text-text backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">新規セッション</h2>
        <button type="button" onClick={onClose} aria-label="新規セッションを閉じる">×</button>
      </div>
      <DelegationSpawnForm />
    </dialog>
  );
}
