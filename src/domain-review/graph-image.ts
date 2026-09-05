/**
 * src/domain-review/graph-image.ts — 層図 HTML → PNG (headless Edge)。
 *
 * **任意の飾り** (設計書 §8.2 C-5)。 撮れなければ null を返し、 投稿はリストだけで
 * 続行する。 ここで例外を投げると 「画像が撮れないと PR 提出通知が飛ばない」 という、
 * 元の目的と真逆の結合ができてしまう。
 *
 * Edge (Chromium) の `--headless=new --screenshot` を使う。 CDP を websocket で
 * 話す実装も可能だが、 1 枚撮るだけのために DevTools セッション管理を持ち込むのは
 * 失敗してよい経路に対して重すぎる。
 *
 * 出力先は OS の temp 配下。 egress の添付許可ルート
 * (`buildAttachmentRoots` は tempDir を含む) の内側なので、 そのまま
 * `attachment_paths` に載せられる。
 *
 * SRP: 撮影とファイル後始末だけ。 絵の中身は layer-diagram.ts。
 *
 * @implements spec/feature/domain-review-discord.md §3
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 撮影の打ち切り。 これを超えたら諦めてリストだけ投稿する。 */
const CAPTURE_TIMEOUT_MS = 20_000;
const VIEWPORT = { width: 1_248, height: 1_400 };

export interface CaptureLayerDiagramInput {
  html: string;
  /** ファイル名に使う識別子 (project code 等)。 英数字以外は落とす。 */
  slug: string;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface CapturedDiagram {
  /** PNG の絶対パス。 投稿後に `release()` で片付ける。 */
  pngPath: string;
  /** 一時ディレクトリごと消す。 失敗しても投げない。 */
  release: () => Promise<void>;
}

/**
 * 層図 PNG を 1 枚撮る。 撮れなければ null (理由は log に残す — 黙って消さない)。
 */
export async function captureLayerDiagram(
  input: CaptureLayerDiagramInput,
): Promise<CapturedDiagram | null> {
  const edge = resolveEdgeBinary();
  if (!edge) {
    input.log?.info("domain-review: headless Edge が見つからないため画像を省略");
    return null;
  }

  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "cc-domain-review-"));
  } catch (error) {
    input.log?.warn(`domain-review: 一時ディレクトリを作れず画像を省略: ${(error as Error).message}`);
    return null;
  }
  const release = async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); };

  const slug = input.slug.replace(/[^A-Za-z0-9_-]/g, "") || "domains";
  const htmlPath = path.join(dir, "layers.html");
  const pngPath = path.join(dir, `${slug}-layers.png`);
  try {
    await writeFile(htmlPath, input.html, "utf8");
  } catch (error) {
    input.log?.warn(`domain-review: 層図 HTML を書けず画像を省略: ${(error as Error).message}`);
    await release();
    return null;
  }

  const exited = await runEdgeScreenshot(edge, {
    htmlPath,
    pngPath,
    userDataDir: path.join(dir, "profile"),
  });
  if (!exited.ok) {
    input.log?.info(`domain-review: 画像化に失敗したためリストのみ投稿する (${exited.reason})`);
    await release();
    return null;
  }
  const size = await stat(pngPath).then((s) => s.size, () => 0);
  if (size === 0) {
    input.log?.info("domain-review: PNG が空だったためリストのみ投稿する");
    await release();
    return null;
  }
  return { pngPath, release };
}

/** Edge の実行ファイル。 env で明示指定でき、 無ければ既知の場所 → PATH。 */
function resolveEdgeBinary(): string | null {
  const configured = process.env.CONCORDIA_EDGE_PATH?.trim();
  if (configured) return configured;
  if (process.platform !== "win32") return null;
  for (const root of [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ]) {
    if (!root) continue;
    const candidate = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(candidate)) return candidate;
  }
  // 既知の場所に無ければ PATH に賭ける。 外れたら spawn の error で「撮れなかった」。
  return "msedge.exe";
}

function runEdgeScreenshot(
  binary: string,
  paths: { htmlPath: string; pngPath: string; userDataDir: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    // 撮影用プロファイルを使い捨てにする。 既定プロファイルを掴むと、 人が
    // 開いている Edge と競合して起動しないことがある。
    `--user-data-dir=${paths.userDataDir}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    // ページ内の JS を仮想時間で走らせきってから撮る。 静的 HTML でも
    // フォント適用前に撮れてしまうのを防ぐ。
    "--virtual-time-budget=2000",
    `--screenshot=${paths.pngPath}`,
    pathToFileURL(paths.htmlPath).href,
  ];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { stdio: "ignore", windowsHide: true });
    } catch (error) {
      finish({ ok: false, reason: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, CAPTURE_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); finish({ ok: false, reason: error.message }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code ?? "null"}` });
    });
  });
}
