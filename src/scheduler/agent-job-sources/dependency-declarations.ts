/**
 * 依存点検の data に入れる依存宣言 (パッケージ名と版指定) を、公開リポの main のマニフェストから読む。
 * 外部エージェント (dots) は URL を読みに行けないため、 Cc が中身を読んで渡す。
 * 読むのは package.json の dependencies / devDependencies だけ (本文・scripts・設定は渡さない)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter (依存点検)
 */

import type { GitRead } from "./git-read.js";

export interface DependencyDeclaration {
  /** リポ root からの相対パス。 */
  manifest: string;
  dependencies: Record<string, string>;
  dev_dependencies: Record<string, string>;
}

const NAME_PATTERN = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu;
const MAX_SPEC_LENGTH = 80;

function pickDeclarations(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const picked: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (!NAME_PATTERN.test(name) || typeof spec !== "string" || spec.length > MAX_SPEC_LENGTH) continue;
    // file: / link: / git+ssh などローカルパスや資格情報を含みうる指定は種別だけを残す。
    picked[name] = /^(?:file:|link:|git\+|git:|ssh:|https?:)/iu.test(spec) ? `${spec.split(":")[0]}:` : spec;
  }
  return picked;
}

/** 純関数: package.json の文字列から依存宣言を取り出す。 JSON でなければ null。 */
export function parsePackageJsonDeclarations(manifest: string, text: string): DependencyDeclaration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    manifest,
    dependencies: pickDeclarations(record.dependencies),
    dev_dependencies: pickDeclarations(record.devDependencies),
  };
}

/** main ブランチの package.json 系マニフェストの依存宣言を読む。 読めないものは飛ばす。 */
export async function readDependencyDeclarations(
  git: GitRead, repoPath: string, manifests: readonly string[],
): Promise<DependencyDeclaration[]> {
  const read = await Promise.all(manifests
    .filter((manifest) => manifest.endsWith("package.json"))
    .map(async (manifest) => {
      const text = await git(repoPath, ["show", `main:${manifest}`]);
      return text ? parsePackageJsonDeclarations(manifest, text) : null;
    }));
  return read.filter((declaration): declaration is DependencyDeclaration => declaration !== null);
}
