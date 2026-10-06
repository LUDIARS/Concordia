/**
 * Concordia 自身の配備を起動時に自分で知らせる (2026-10-06 neco 指示「デプロイの通知は GLab にも飛ばそう」)。
 *
 * 配備通知は Excubitor が再起動の直後に `/v1/events/service-deployed` を呼ぶ作り。 Concordia 自身を
 * 再起動したときは、 呼ばれた瞬間に Concordia がまだ起動しておらず通知が抜け落ちていた (台帳の concordia は
 * 10/01 の 2 件だけ)。 起動後に自分の版を台帳の直前の版と比べ、 変わっていれば同じ配備処理を流す。
 * 台帳は同じ版を 1 回しか受け付けないので、 Excubitor の呼び出しが届いても二重には送らない。
 *
 * @implements spec/feature/service-deployed-notify.md §Concordia 自身の配備
 */
import type { ServiceDeployedEvent } from "./service-deployed.js";

export const SELF_SERVICE_CODE = "concordia";

export interface SelfDeploymentInput {
  /** 起動したコードの版 (git の短い hash)。 取れなければ null (何もしない)。 */
  currentHash: string | null;
  /** 台帳に残る直前の版。 無ければ null (比べられないので何もしない)。 */
  previousHash: string | null;
  version: string;
  startedAt: string;
  handle(event: ServiceDeployedEvent): Promise<unknown>;
}

/** 版が変わっていれば配備処理を流して true。 変わっていない・比べられないなら false。 */
export async function reportSelfDeployment(input: SelfDeploymentInput): Promise<boolean> {
  const current = input.currentHash?.trim() ?? "";
  const previous = input.previousHash?.trim() ?? "";
  if (current.length < 7 || previous.length < 7) return false;
  // 長さの違う短い hash どうしでも同じ版とみなす。
  if (current.startsWith(previous) || previous.startsWith(current)) return false;
  await input.handle({
    code: SELF_SERVICE_CODE,
    previousHash: previous,
    currentHash: current,
    version: input.version,
    startedAt: input.startedAt,
    restartCount: 0,
  });
  return true;
}

/** 起動後に 1 回だけ自己報告する。 Discord の投稿は REST なので Gateway の準備は待たないが、 起動直後の混雑は避ける。 */
export function startSelfDeploymentReport(input: {
  latestHash(code: string): string | null;
  readHead(): Promise<string | null>;
  version: string;
  handle(event: ServiceDeployedEvent): Promise<unknown>;
  log: { info(message: string): void; warn(message: string): void };
  delayMs?: number;
}): { stop(): void } {
  const timer = setTimeout(() => {
    void (async () => {
      const previousHash = input.latestHash(SELF_SERVICE_CODE);
      const currentHash = await input.readHead().catch(() => null);
      const reported = await reportSelfDeployment({
        currentHash, previousHash, version: input.version, startedAt: new Date().toISOString(), handle: input.handle,
      });
      input.log.info(`self deployment ${reported ? "reported" : "unchanged"} previous=${previousHash ?? "-"} current=${currentHash ?? "-"}`);
    })().catch((error) => input.log.warn(`self deployment report failed: ${(error as Error).message}`));
  }, input.delayMs ?? 15_000);
  timer.unref?.();
  return { stop: () => clearTimeout(timer) };
}
