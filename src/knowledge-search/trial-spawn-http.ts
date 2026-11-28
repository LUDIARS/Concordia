/**
 * 「セッションを起動して試す」の起動 port を Cc の spawn API で実装する (KS-11)。
 *
 * `/co-spawn` と同じ `/v1/admin/spawn-session` に、 ナレッジのコンテキストを prompt として渡す。
 * SRP: HTTP 呼び出しだけ。
 */

import type { TrialSpawnPort } from "./trial.js";

export function httpTrialSpawner(concordiaUrl: string, fetchImpl: typeof fetch = fetch): TrialSpawnPort {
  return {
    async spawn(prompt) {
      const res = await fetchImpl(`${concordiaUrl}/v1/admin/spawn-session`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ provider: "claude", prompt }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; pid?: number };
      return res.ok ? { ok: true, pid: typeof json.pid === "number" ? json.pid : null } : { ok: false, error: json.error ?? `HTTP ${res.status}` };
    },
  };
}
