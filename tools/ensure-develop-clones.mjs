import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = "E:/Document/Ars";

export function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git command failed").trim();
    throw new Error(`git ${args.join(" ")}: ${detail}`);
  }
  return result.stdout.trim();
}

function tryGit(cwd, args) {
  try {
    return { ok: true, output: runGit(cwd, args) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseArgs(argv) {
  let apply = false;
  let root = DEFAULT_ROOT;
  const excluded = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      apply = false;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      if (!root) throw new Error("--root requires a path");
      continue;
    }
    if (arg === "--exclude") {
      const value = argv[index + 1];
      if (!value) throw new Error("--exclude requires repository names");
      addExcluded(excluded, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      addExcluded(excluded, arg.slice("--exclude=".length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { apply, root: resolve(root), excluded };
}

function addExcluded(excluded, value) {
  for (const name of value.split(",")) {
    const trimmed = name.trim();
    if (trimmed) excluded.add(trimmed.toLowerCase());
  }
}

export function findMainRepositories(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`workspace root does not exist: ${root}`);
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((repository) => {
      const gitPath = join(repository, ".git");
      return existsSync(gitPath) && statSync(gitPath).isDirectory();
    })
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

function remoteBranches(repository) {
  const output = runGit(repository, ["ls-remote", "--heads", "origin"]);
  const branches = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\trefs\/heads\/(.+)$/);
    if (match) branches.add(match[1]);
  }
  return branches;
}

function defaultRemoteBranch(repository) {
  const output = runGit(repository, ["ls-remote", "--symref", "origin", "HEAD"]);
  const match = output.match(/^ref: refs\/heads\/(.+)\tHEAD$/m);
  if (!match) throw new Error("origin default branch could not be determined");
  return match[1];
}

function createDevelopBranch(repository, sourceBranch) {
  runGit(repository, ["rev-parse", "--verify", `refs/remotes/origin/${sourceBranch}`]);
  runGit(repository, [
    "push",
    "origin",
    `refs/remotes/origin/${sourceBranch}:refs/heads/develop`,
  ]);
}

function createDevelopClone(originUrl, clonePath) {
  const parent = resolve(clonePath, "..");
  mkdirSync(parent, { recursive: true });
  // A generated develop clone must not run user template hooks (for example
  // Git LFS hooks) while this maintenance operation is creating it.
  runGit(parent, [
    "-c",
    "core.hooksPath=NUL",
    "-c",
    "init.templateDir=NUL",
    "clone",
    "--branch",
    "develop",
    originUrl,
    clonePath,
  ]);
}

function updateDevelopClone(clonePath) {
  runGit(clonePath, ["fetch", "origin"]);
  runGit(clonePath, ["reset", "--hard", "origin/develop"]);
}

function formatActions(actions) {
  return actions.map((action) => action.label).join(",");
}

export async function ensureDevelopClones(options) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const apply = options.apply === true;
  const excluded = options.excluded ?? new Set();
  const write = options.write ?? ((line) => console.log(line));
  const summary = {
    targets: 0,
    branchesCreated: 0,
    clonesCreated: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  const repositories = findMainRepositories(root);
  const developRoot = join(root, "develop");

  for (const repository of repositories) {
    const name = basename(repository);
    if (excluded.has(name.toLowerCase())) {
      summary.skipped += 1;
      write(`[skip] ${name}: excluded`);
      continue;
    }

    const originResult = tryGit(repository, ["remote", "get-url", "origin"]);
    if (!originResult.ok || !originResult.output) {
      summary.skipped += 1;
      write(`[skip] ${name}: origin remote not found`);
      continue;
    }

    summary.targets += 1;
    const clonePath = join(developRoot, name);

    try {
      const branches = remoteBranches(repository);
      const developExists = branches.has("develop");
      const sourceBranch = branches.has("main") ? "main" : defaultRemoteBranch(repository);
      if (!branches.has(sourceBranch)) {
        throw new Error(`origin branch not found: ${sourceBranch}`);
      }

      const actions = [];
      if (!developExists) {
        actions.push({ label: "create-branch", detail: `develop <- origin/${sourceBranch}` });
      }

      const cloneExists = existsSync(clonePath);
      let cloneDirty = false;
      if (cloneExists) {
        const statusResult = tryGit(clonePath, ["status", "--porcelain"]);
        if (!statusResult.ok) {
          throw new Error(`existing develop path is not a git repository: ${clonePath}`);
        }
        cloneDirty = statusResult.output.length > 0;
        if (cloneDirty) {
          actions.push({ label: "skip", detail: "develop clone has uncommitted changes" });
        } else {
          actions.push({ label: "update", detail: "fetch + reset origin/develop" });
        }
      } else {
        actions.push({ label: "clone", detail: clonePath });
      }

      const actionLine = `[${formatActions(actions)}] ${name}: ${actions
        .map((action) => action.detail)
        .join("; ")}`;
      if (!apply) {
        if (!developExists) summary.branchesCreated += 1;
        if (cloneDirty) {
          summary.skipped += 1;
        } else if (cloneExists) {
          summary.updated += 1;
        } else {
          summary.clonesCreated += 1;
        }
        write(actionLine);
        continue;
      }

      if (!developExists) {
        createDevelopBranch(repository, sourceBranch);
        summary.branchesCreated += 1;
      }
      if (cloneDirty) {
        summary.skipped += 1;
      } else if (cloneExists) {
        updateDevelopClone(clonePath);
        summary.updated += 1;
      } else {
        createDevelopClone(originResult.output, clonePath);
        summary.clonesCreated += 1;
      }
      write(actionLine);
    } catch (error) {
      summary.failed += 1;
      write(`[failed] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  write(
    `対象 ${summary.targets} リポ / develop ブランチ作成 ${summary.branchesCreated}` +
      ` / クローン作成 ${summary.clonesCreated} / 更新 ${summary.updated}` +
      ` / スキップ ${summary.skipped} / 失敗 ${summary.failed}`,
  );
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  return ensureDevelopClones(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main()
    .then((summary) => {
      if (summary.failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
