/** The ingress accepts one new, assigned branch, never arbitrary Git commands. */
export interface GitReceiveCommand { newOid: string; ref: string; packOffset: number }

export function cloudReturnRef(provider: "codex-cloud" | "claude-cloud", attemptId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId)) throw new Error("invalid_cloud_attempt");
  return `refs/heads/cloud/${provider}/${attemptId}`;
}

/** Parse only the command prefix; PACK bytes are passed unchanged to Git's validator. */
export function parseCloudReceiveCommand(bytes: Buffer, assignedRef: string, oidLength: 40 | 64): GitReceiveCommand {
  const reject = (): never => { throw new Error("cloud_git_command_rejected"); };
  if (!/^refs\/heads\/cloud\/(codex-cloud|claude-cloud)\/[A-Za-z0-9_-]{1,100}$/.test(assignedRef)) return reject();
  if (bytes.length < 4 || bytes.subarray(0, 4).some(byte => byte > 127)) return reject();
  const header = bytes.subarray(0, 4).toString("ascii");
  if (!/^[0-9a-fA-F]{4}$/.test(header)) return reject();
  const length = Number.parseInt(header, 16);
  if (length < 4 || length > 4096 || bytes.length < length + 4) return reject();
  // Ref names and capabilities here are deliberately ASCII; reject lossy decoding.
  const raw = bytes.subarray(4, length);
  if (raw.some(byte => byte > 127)) return reject();
  const line = raw.toString("ascii").replace(/\n$/, "");
  const segments = line.split("\0");
  if (segments.length > 2) return reject();
  const fields = segments[0]!.split(" ");
  if (fields.length !== 3) return reject();
  const [oldOid, newOid, ref] = fields;
  if (oldOid !== "0".repeat(oidLength) || !newOid || !new RegExp(`^[a-f0-9]{${oidLength}}$`).test(newOid)
    || newOid === oldOid || ref !== assignedRef) return reject();
  const capabilities = segments[1]?.split(" ").filter(Boolean) ?? [];
  // Reject push-options, signed pushes and capabilities changing command framing.
  if (capabilities.some(c => !/^(report-status|report-status-v2|side-band-64k|quiet|atomic|ofs-delta)$/.test(c)
    && !/^agent=[A-Za-z0-9._/+()-]{1,120}$/.test(c)
    && c !== `object-format=${oidLength === 40 ? "sha1" : "sha256"}`)) return reject();
  if (!bytes.subarray(length, length + 4).equals(Buffer.from("0000"))) return reject();
  const packOffset = length + 4;
  if (!bytes.subarray(packOffset, packOffset + 4).equals(Buffer.from("PACK"))) return reject();
  return { newOid, ref: assignedRef, packOffset };
}
