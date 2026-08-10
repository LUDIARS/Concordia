import { useEffect, useState } from "react";
import { api } from "../api.js";

/** Excubitor が実行中 backend に注入した version を表示する。 */
export function RuntimeVersion() {
  const [version, setVersion] = useState("unavailable");

  useEffect(() => {
    let active = true;
    void api.health()
      .then((health) => {
        const resolved = health.version.trim();
        if (active && resolved) setVersion(resolved);
      })
      .catch(() => {
        // ヘッダの補助表示は best-effort。health 失敗は各ページの通常エラー面に委ねる。
      });
    return () => { active = false; };
  }, []);

  return <span className="text-subtle text-xs">v{version}</span>;
}
