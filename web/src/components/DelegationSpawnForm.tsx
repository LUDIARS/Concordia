import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api.js";
import type { DelegationTemplateLite, SpawnProvider } from "../api.js";

type LaunchKind = "template" | "provider";
type WindowMode = "tab" | "window";

const DIRECT_PROVIDERS: SpawnProvider[] = ["claude", "codex", "gemini", "gemma4-12"];

export function DelegationSpawnForm({
  subsidiaryId = null,
  className = "",
  templates,
  projects,
  showTitle = false,
}: {
  subsidiaryId?: string | null;
  className?: string;
  templates?: DelegationTemplateLite[];
  projects?: string[];
  showTitle?: boolean;
}) {
  const projectListId = useId();
  const [localTemplates, setLocalTemplates] = useState<DelegationTemplateLite[]>([]);
  const [localProjects, setLocalProjects] = useState<string[]>([]);
  const [launchKind, setLaunchKind] = useState<LaunchKind>("template");
  const [callName, setCallName] = useState("");
  const [provider, setProvider] = useState<SpawnProvider>("claude");
  const [mode, setMode] = useState<WindowMode>("tab");
  const [project, setProject] = useState("");
  const [injectPrompt, setInjectPrompt] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [runtimeOptions, setRuntimeOptions] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (templates) return;
    api.delegationTemplates()
      .then((r) => setLocalTemplates(r.templates.filter((t) => !t.call_only)))
      .catch(() => setLocalTemplates([]));
  }, [templates]);

  useEffect(() => {
    if (projects) return;
    api.workRepos()
      .then((r) => setLocalProjects(projectNames(r.repos)))
      .catch(() => setLocalProjects([]));
  }, [projects]);

  const spawnableTemplates = useMemo(
    () => (templates ?? localTemplates).filter((t) => !t.call_only),
    [templates, localTemplates],
  );
  const projectOptions = useMemo(
    () => [...(projects ?? localProjects)].sort((a, b) => a.localeCompare(b)),
    [projects, localProjects],
  );
  const selected = spawnableTemplates.find((t) => t.call_name === callName) ?? null;

  useEffect(() => {
    if (spawnableTemplates.length === 0) {
      if (launchKind === "template") setLaunchKind("provider");
      return;
    }
    if (!callName || !spawnableTemplates.some((t) => t.call_name === callName)) {
      setCallName(spawnableTemplates[0].call_name);
    }
  }, [callName, launchKind, spawnableTemplates]);

  useEffect(() => {
    if (!selected) {
      setArgs({});
      setRuntimeOptions({});
      return;
    }
    const initArgs: Record<string, string> = {};
    for (const item of selected.input_schema) {
      initArgs[item.name] = item.default !== undefined ? String(item.default) : "";
    }
    const initOptions: Record<string, string> = {};
    const defaults = selected.default_options ?? {};
    for (const opt of selected.runtime_options ?? []) {
      initOptions[opt.key] = optionValue(defaults[opt.key]);
    }
    setArgs(initArgs);
    setRuntimeOptions(initOptions);
  }, [selected?.call_name]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    if (launchKind === "template" && !selected) return;
    setSending(true);
    setResult(null);
    try {
      const body: Parameters<typeof api.adminSpawn>[0] = { mode };
      const projectName = project.trim();
      const promptText = prompt.trim();
      if (subsidiaryId) body.subsidiary_id = subsidiaryId;
      if (projectName) body.project = projectName;

      if (launchKind === "template" && selected) {
        body.template = selected.call_name;
        body.inject_prompt = injectPrompt;
        const options = collectRuntimeOptions(selected, runtimeOptions);
        if (Object.keys(options).length > 0) body.options = options;
        if (injectPrompt) {
          body.args = collectTemplateArgs(selected, args);
          if (promptText) body.prompt = promptText;
        }
      } else {
        body.provider = provider;
        if (promptText) body.prompt = promptText;
      }

      const r = await api.adminSpawn(body);
      setResult({
        ok: !!r.ok,
        text: r.ok
          ? `spawned${projectName ? ` ${projectName}` : ""} (pid ${r.pid ?? "?"}${r.injected_prompt ? ", prompt" : ""})`
          : (r.error ?? "spawn failed"),
      });
      if (r.ok) setPrompt("");
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const selectedTemplate = launchKind === "template" ? selected : null;
  const showPromptBox = launchKind === "provider" || injectPrompt;

  return (
    <form onSubmit={submit} className={`space-y-2 ${className}`}>
      {showTitle && (
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">新規セッション</span>
          <span className="text-xs text-subtle">delegation / provider spawn</span>
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex gap-2">
          <select
            className="foundation-form text-xs w-28"
            value={launchKind}
            onChange={(e) => setLaunchKind(e.target.value as LaunchKind)}
            disabled={sending || spawnableTemplates.length === 0}
          >
            <option value="template">delegation</option>
            <option value="provider">provider</option>
          </select>
          {launchKind === "template" ? (
            <select
              className="foundation-form text-xs flex-1 min-w-0"
              value={callName}
              onChange={(e) => setCallName(e.target.value)}
              disabled={sending || spawnableTemplates.length === 0}
            >
              {spawnableTemplates.map((t) => (
                <option key={t.id} value={t.call_name}>{t.title || t.call_name}</option>
              ))}
            </select>
          ) : (
            <select
              className="foundation-form text-xs flex-1 min-w-0"
              value={provider}
              onChange={(e) => setProvider(e.target.value as SpawnProvider)}
              disabled={sending}
            >
              {DIRECT_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </div>
        <div className="flex gap-2">
          <input
            className="foundation-form text-xs flex-1 min-w-0"
            list={projectListId}
            placeholder="project (Work)"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            disabled={sending}
          />
          <datalist id={projectListId}>
            {projectOptions.map((name) => <option key={name} value={name} />)}
          </datalist>
          <select
            className="foundation-form text-xs w-20"
            value={mode}
            onChange={(e) => setMode(e.target.value as WindowMode)}
            disabled={sending}
          >
            <option value="tab">tab</option>
            <option value="window">window</option>
          </select>
        </div>
      </div>

      {selectedTemplate && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-subtle">
          <span>provider: <code>{selectedTemplate.target_provider}</code></span>
          <span>model: <code>{selectedTemplate.model ?? "default"}</code></span>
          <label className="ml-auto flex items-center gap-1">
            <input
              type="checkbox"
              checked={injectPrompt}
              onChange={(e) => setInjectPrompt(e.target.checked)}
              disabled={sending}
            />
            prompt 注入
          </label>
        </div>
      )}

      {selectedTemplate && (selectedTemplate.runtime_options ?? []).length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {(selectedTemplate.runtime_options ?? []).map((opt) => (
            <label key={opt.key} className="text-xs space-y-1">
              <span className="text-subtle">{opt.label}</span>
              {opt.type === "select" ? (
                <select
                  className="foundation-form w-full text-xs"
                  value={runtimeOptions[opt.key] ?? ""}
                  onChange={(e) => setRuntimeOptions({ ...runtimeOptions, [opt.key]: e.target.value })}
                  disabled={sending}
                >
                  <option value="">default</option>
                  {(opt.choices ?? []).map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                  ))}
                </select>
              ) : opt.type === "boolean" ? (
                <select
                  className="foundation-form w-full text-xs"
                  value={runtimeOptions[opt.key] ?? ""}
                  onChange={(e) => setRuntimeOptions({ ...runtimeOptions, [opt.key]: e.target.value })}
                  disabled={sending}
                >
                  <option value="">default</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  className="foundation-form w-full text-xs"
                  value={runtimeOptions[opt.key] ?? ""}
                  onChange={(e) => setRuntimeOptions({ ...runtimeOptions, [opt.key]: e.target.value })}
                  disabled={sending}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {selectedTemplate && injectPrompt && selectedTemplate.input_schema.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {selectedTemplate.input_schema.map((item) => (
            <label key={item.name} className="text-xs space-y-1">
              <span className="text-subtle">
                {item.name} <span className="font-mono">{item.type}</span>
                {item.required && <span className="text-danger"> *</span>}
              </span>
              <input
                className="foundation-form w-full text-xs"
                value={args[item.name] ?? ""}
                onChange={(e) => setArgs({ ...args, [item.name]: e.target.value })}
                disabled={sending}
              />
            </label>
          ))}
        </div>
      )}

      {showPromptBox && (
        <textarea
          className="foundation-form w-full text-xs resize-y"
          rows={2}
          placeholder={launchKind === "template" ? "追加プロンプト" : "初回プロンプト"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={sending}
        />
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={sending || (launchKind === "template" && !selected)}
          className="bg-accent text-bg px-3 py-1 rounded text-xs font-medium disabled:opacity-50"
        >
          {sending ? "Spawning..." : "Spawn"}
        </button>
        {result && (
          <span className={`text-[11px] ${result.ok ? "text-ok" : "text-danger"}`}>{result.text}</span>
        )}
      </div>
    </form>
  );
}

function optionValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function collectTemplateArgs(
  selected: DelegationTemplateLite,
  args: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selected.input_schema) {
    const value = args[item.name];
    if (value === undefined || value === "") continue;
    if (item.type === "number") out[item.name] = Number(value);
    else if (item.type === "boolean") out[item.name] = value === "true";
    else out[item.name] = value;
  }
  return out;
}

function collectRuntimeOptions(
  selected: DelegationTemplateLite,
  runtimeOptions: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const opt of selected.runtime_options ?? []) {
    const value = runtimeOptions[opt.key];
    if (value === undefined || value === "") continue;
    if (opt.type === "number") out[opt.key] = Number(value);
    else if (opt.type === "boolean") out[opt.key] = value === "true";
    else out[opt.key] = value;
  }
  return out;
}

function projectNames(repos: Array<{ name: string }>): string[] {
  return [...new Set(repos.map((r) => r.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
