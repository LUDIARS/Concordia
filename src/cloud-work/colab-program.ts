import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ColabBinding } from "./colab-config.js";

const exec = promisify(execFile);
const MAX_PROGRAM_BYTES = 512_000;
const Notebook = z.object({ nbformat: z.literal(4), cells: z.array(z.object({
  cell_type: z.string(), source: z.union([z.string(), z.array(z.string())]),
})).max(250) });

type ReadGitBlob = (repoPath: string, revision: string, path: string) => Promise<Buffer>;
const readGitBlob: ReadGitBlob = async (repoPath, revision, path) => {
  const result = await exec("git", ["show", `${revision}:${path}`], {
    cwd: repoPath, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: MAX_PROGRAM_BYTES, encoding: "buffer",
  });
  return result.stdout;
};

export async function readRegisteredColabProgram(repoPath: string, revision: string,
  binding: Pick<ColabBinding, "program" | "programSha256">, read: ReadGitBlob = readGitBlob): Promise<string> {
  let bytes: Buffer;
  try { bytes = await read(repoPath, revision, binding.program); }
  catch { throw new Error("cloud_colab_program_unverified"); }
  if (bytes.length > MAX_PROGRAM_BYTES || createHash("sha256").update(bytes).digest("hex") !== binding.programSha256) {
    throw new Error("cloud_colab_program_unverified");
  }
  const program = bytes.toString("utf8");
  if (binding.program.endsWith(".py")) return program;
  const notebook = Notebook.parse(JSON.parse(program));
  const cells = notebook.cells.filter(cell => cell.cell_type === "code")
    .map(cell => Array.isArray(cell.source) ? cell.source.join("") : cell.source);
  if (!cells.length) throw new Error("cloud_colab_program_unverified");
  const payload = Buffer.from(JSON.stringify(cells), "utf8").toString("base64");
  return [
    "import base64 as _cc_b64, json as _cc_json",
    `for _cc_cell in _cc_json.loads(_cc_b64.b64decode("${payload}")):`,
    "    _cc_result = get_ipython().run_cell(_cc_cell, store_history=False)",
    "    _cc_result.raise_error()",
  ].join("\n");
}
