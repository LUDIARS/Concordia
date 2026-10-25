import fs from "node:fs";
import path from "node:path";

export type AttachmentCheck =
  | { ok: true; realPath: string }
  | { ok: false; reason: "not_absolute" | "not_found" | "outside_roots" | "denied_name" | "unc" | "symlink_escape" };

export interface AttachmentGuard {
  check(rawPath: string): Promise<AttachmentCheck>;
}

export function parseAttachmentRoots(value: string | undefined): string[] {
  return value?.split(";").map((root) => root.trim()).filter(Boolean) ?? [];
}

export function buildAttachmentRoots(input: {
  workspaceRoots: string[];
  tempDir: string;
  configuredRoots: string | undefined;
}): string[] {
  return [...input.workspaceRoots, input.tempDir, ...parseAttachmentRoots(input.configuredRoots)];
}

export function createAttachmentGuard(opts: { roots: string[]; enforce: boolean }): AttachmentGuard {
  // The guard always reports the actual result; callers decide whether audit mode blocks it.
  void opts.enforce;
  // A root can be an alias of its real directory: on Windows os.tmpdir() is often an 8.3 short
  // name (C:\Users\ABCDEF~1\...) while the same directory also has a long name, and realpath does
  // not always expand one into the other. Each root counts in both forms, for the requested path
  // and for the resolved one, so an alias neither rejects a file nor hides a symlink escape.
  const roots = [...new Set(opts.roots.filter(Boolean).flatMap((root) => [normalizePath(root), realRootPath(root)]))];

  return {
    async check(rawPath: string): Promise<AttachmentCheck> {
      // UNC 判定を isAbsolute より先に置く。POSIX では "\\\\server\\share" が
      // 絶対パスと見なされず not_absolute で先に落ちてしまい、判定理由が
      // プラットフォームで変わる (Linux CI と Windows で結果が割れた)。
      if (isUncPath(rawPath)) return { ok: false, reason: "unc" };
      if (!path.isAbsolute(rawPath)) return { ok: false, reason: "not_absolute" };

      const requestedPath = normalizePath(rawPath);
      const requestedInsideRoots = isWithinAnyRoot(roots, requestedPath);
      let realPath: string;
      try {
        realPath = await fs.promises.realpath(rawPath);
      } catch {
        return { ok: false, reason: "not_found" };
      }

      const normalizedRealPath = normalizePath(realPath);
      const realInsideRoots = isWithinAnyRoot(roots, normalizedRealPath);
      if (requestedInsideRoots !== realInsideRoots) return { ok: false, reason: "symlink_escape" };
      if (!realInsideRoots) return { ok: false, reason: "outside_roots" };
      if (isDeniedBasename(path.basename(realPath))) return { ok: false, reason: "denied_name" };
      return { ok: true, realPath };
    },
  };
}

// The native realpath expands an 8.3 short name to the long one. A root that does not exist yet
// keeps its configured form.
function realRootPath(root: string): string {
  try {
    return normalizePath(fs.realpathSync.native(root));
  } catch {
    return normalizePath(root);
  }
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+/g, path.sep);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinAnyRoot(roots: string[], target: string): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
  });
}

function isUncPath(value: string): boolean {
  return /^\\\\(?:[?.]\\|[^\\])/.test(value);
}

function isDeniedBasename(value: string): boolean {
  const basename = value.toLowerCase();
  return basename === ".env"
    || /^\.env\./.test(basename)
    || /\.(pem|key|p12|pfx|token|kdbx)$/.test(basename)
    || /^id_rsa/.test(basename)
    || /^id_ed25519/.test(basename)
    || /^credentials/.test(basename);
}
