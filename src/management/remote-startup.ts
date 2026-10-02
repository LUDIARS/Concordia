import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";
import { readManagementRemoteConfig } from "./remote-config.js";
import { startManagementRemoteListener, type ManagementRemoteHandle } from "./remote-listener.js";
import type { ManagementService } from "./service.js";

/**
 * dots 専用の入口の寿命 (CC-MGMT-07)。 設定不正・起動失敗は Cc 本体を止めずにエラー通知へ出す。
 * stop は起動中でも安全に呼べる (起動完了を待ってから閉じる)。
 */
export interface ManagementRemoteRuntime {
  stop: () => Promise<void>;
}

type Start = typeof startManagementRemoteListener;
type Report = (source: string, message: string) => void;

export function startManagementRemote(
  env: Readonly<Record<string, string | undefined>>,
  service: ManagementService,
  start: Start = startManagementRemoteListener,
  report: Report = reportError,
): ManagementRemoteRuntime {
  const log = createChildLogger("management/remote");
  let config;
  try {
    config = readManagementRemoteConfig(env);
  } catch (error) {
    report("management", `dots 専用の入口の設定が不正です: ${(error as Error).message}`);
    return { stop: async () => {} };
  }
  if (!config) return { stop: async () => {} };
  if (config.publicAccess && !config.publicAccess.access) {
    report("management", `dots 専用の入口: 公開ホスト ${config.publicAccess.host} の Cloudflare Access 設定 (team / aud) が未設定です。設定されるまで公開側の要求は全て拒否します (Tailscale 側は動きます)`);
  }
  const started: Promise<ManagementRemoteHandle | null> = start(config, service).then(
    (handle) => {
      log.info(`management remote listener started on ${handle.host}:${handle.port}`);
      return handle;
    },
    (error: Error) => {
      report("management", `dots 専用の入口を起動できませんでした (${config.host}:${config.port}): ${error.message}`);
      return null;
    },
  );
  return {
    stop: async () => {
      const handle = await started;
      await handle?.close();
    },
  };
}
