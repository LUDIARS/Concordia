import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs } from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { requireOk, runMutation } from "../../lib/mutation.js";
import { EMPTY_FORM, type FormMode, type Rule, type RuleForm, type RuleLog } from "./model.js";

export function useRulesState() {
  const { data: rulesData, error, refetch } = useLiveQuery<{ rules: Rule[] }>(
    () => fetch("/v1/rules").then((r) => r.json()),
    ["rule.changed"],
  );
  const { data: logData } = useLiveQuery<{ logs: RuleLog[] }>(
    () => fetch("/v1/rules/log?limit=50").then((r) => r.json()),
    ["rule.changed"],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [aiAssisting, setAiAssisting] = useState(false);
  const [eventKinds, setEventKinds] = useState<string[]>(["*"]);

  // event_kind dropdown 用に backend から候補を取る
  useEffect(() => {
    fetch("/v1/rules/event-kinds")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.event_kinds)) setEventKinds(j.event_kinds);
      })
      .catch(() => {});
  }, []);

  const startCreate = () => {
    setMode({ kind: "create" });
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const startEdit = (r: Rule) => {
    setMode({ kind: "edit", ruleId: r.id });
    setForm({
      id: r.id,
      description: r.description ?? "",
      trigger_type: r.trigger_type,
      tick_sec: r.tick_sec != null ? String(r.tick_sec) : "300",
      event_kind: r.event_kind ?? "",
      cooldown_sec: String(r.cooldown_sec),
      instructions: r.instructions,
      enabled: r.enabled,
    });
    setFormError(null);
  };

  const cancelForm = () => {
    setMode(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const toggle = async (id: string) => {
    await runMutation({
      setBusy: (value) => setBusy(value ? id : null),
      setError: setFormError,
      action: async () => requireOk(await fetch(`/v1/rules/${encodeURIComponent(id)}/toggle`, { method: "POST" })),
      onSuccess: refetch,
      errorPrefix: "toggle 失敗: ",
    });
  };

  const remove = async (id: string) => {
    const reason = prompt("削除理由 (任意):") ?? "";
    await runMutation({
      confirmMessage: `rule "${id}" を削除しますか?`,
      setBusy: (value) => setBusy(value ? id : null),
      setError: setFormError,
      action: async () => requireOk(await fetch(`/v1/rules/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      })),
      onSuccess: refetch,
      errorPrefix: "削除失敗: ",
    });
  };

  const aiAssist = async () => {
    await runMutation({
      setBusy: setAiAssisting,
      setError: setFormError,
      errorPrefix: "AI 補完失敗: ",
      action: async () => {
      const partial: any = {};
      if (form.id) partial.id = form.id;
      if (form.description) partial.description = form.description;
      partial.trigger_type = form.trigger_type;
      if (form.trigger_type === "tick" && form.tick_sec) partial.tick_sec = Number(form.tick_sec);
      if (form.trigger_type === "event" && form.event_kind) partial.event_kind = form.event_kind;
      if (form.cooldown_sec) partial.cooldown_sec = Number(form.cooldown_sec);
      if (form.instructions) partial.instructions = form.instructions;

      const r = await fetch("/v1/rules/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partial }),
      });
      await requireOk(r);
      const j = await r.json();
      const rule = j.rule ?? {};
      // ユーザが既に埋めた値は上書きしない (空のスロットだけ AI 候補で埋める)
      setForm((prev) => ({
        id: prev.id || (rule.id ?? ""),
        description: prev.description || (rule.description ?? ""),
        trigger_type: prev.trigger_type, // ユーザ選択尊重
        tick_sec:
          prev.trigger_type === "tick"
            ? prev.tick_sec || (rule.tick_sec != null ? String(rule.tick_sec) : "300")
            : prev.tick_sec,
        event_kind:
          prev.trigger_type === "event"
            ? prev.event_kind || (rule.event_kind ?? "")
            : prev.event_kind,
        cooldown_sec: prev.cooldown_sec || (rule.cooldown_sec != null ? String(rule.cooldown_sec) : "300"),
        instructions: prev.instructions || (rule.instructions ?? ""),
        enabled: prev.enabled,
      }));
      },
    });
  };

  const submitForm = async () => {
    setFormError(null);
    if (!form.instructions) {
      setFormError("instructions は必須です");
      return;
    }
    if (mode?.kind === "create" && !form.id) {
      setFormError("id は必須です");
      return;
    }
    await runMutation({
      setBusy: setFormSubmitting,
      setError: setFormError,
      action: async () => {
      const isEdit = mode?.kind === "edit";
      const body: any = {
        description: form.description || null,
        trigger_type: form.trigger_type,
        instructions: form.instructions,
        cooldown_sec: Number(form.cooldown_sec) || 60,
      };
      if (form.trigger_type === "tick") {
        body.tick_sec = Number(form.tick_sec) || 300;
        body.event_kind = null;
      } else {
        body.event_kind = form.event_kind || null;
        body.tick_sec = null;
      }
      let r: Response;
      if (isEdit) {
        r = await fetch(`/v1/rules/${encodeURIComponent((mode as any).ruleId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        body.id = form.id;
        body.conditions = [];
        body.enabled = form.enabled;
        r = await fetch("/v1/rules", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      await requireOk(r);
      },
      onSuccess: () => {
        cancelForm();
        refetch();
      },
    });
  };

  const rules = rulesData?.rules ?? [];
  const logs = logData?.logs ?? [];

  return { error, refetch, busy, mode, setMode, form, setForm, formError, formSubmitting, aiAssisting, eventKinds, startCreate, startEdit, cancelForm, toggle, remove, aiAssist, submitForm, rules, logs };
}
