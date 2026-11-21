import { createHash } from "node:crypto";

export default {
  post(result: boolean, bytes: Buffer, expected: { name: string; bytes: number; sha256: string }): boolean {
    const limit = (expected.name === "cc-result.json" ? 128 : 16 * 1024) * 1024;
    return result === (bytes.length <= limit && bytes.length === expected.bytes
      && createHash("sha256").update(bytes).digest("hex") === expected.sha256);
  },
};
