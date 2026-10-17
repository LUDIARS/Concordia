import { describe, expect, it } from "vitest";
import { cloudReturnRef, parseCloudReceiveCommand } from "./git-receive-policy.js";

const ref = cloudReturnRef("claude-cloud", "run_123");
const zero = "0".repeat(40), oid = "a".repeat(40);
const packet = (line: string): Buffer => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line);
const request = (line = `${zero} ${oid} ${ref}\0report-status-v2 side-band-64k object-format=sha1 agent=git/2.50.0`) =>
  Buffer.concat([packet(line), Buffer.from("0000PACK\x00\x00\x00\x02", "binary")]);

describe("cloud Git receive boundary", () => {
  it("accepts exactly the allocated new branch and preserves the binary pack offset", () => {
    const bytes = request();
    const parsed = parseCloudReceiveCommand(bytes, ref, 40);
    expect(parsed).toMatchObject({ newOid: oid, ref });
    expect(bytes.subarray(parsed.packOffset)).toEqual(Buffer.from("PACK\x00\x00\x00\x02", "binary"));
  });
  it.each([
    `${oid} ${oid} ${ref}`, `${zero} ${zero} ${ref}`, `${zero} ${oid} refs/heads/main`,
    `${zero} ${oid} refs/tags/release`, `${zero} ${oid} ${ref}\0push-options`,
    `shallow ${oid}`, `${zero} ${oid} ${ref}\0report-status\0extra`,
    `${zero} ${oid} ${ref}\0object-format=sha256`,
  ])("rejects unauthorized or differently framed commands: %s", line => {
    expect(() => parseCloudReceiveCommand(request(line), ref, 40)).toThrow("cloud_git_command_rejected");
  });
  it("rejects a second command before the flush", () => {
    const bytes = Buffer.concat([packet(`${zero} ${oid} ${ref}`), request()]);
    expect(() => parseCloudReceiveCommand(bytes, ref, 40)).toThrow();
  });
  it.each([Buffer.alloc(0), Buffer.from("zzzz"), Buffer.from("ffffx"), Buffer.from("0000PACK")])("rejects malformed framing", bytes => {
    expect(() => parseCloudReceiveCommand(bytes, ref, 40)).toThrow();
  });
  it("supports SHA256 repositories without mixing object formats", () => {
    const bytes = request(`${"0".repeat(64)} ${"b".repeat(64)} ${ref}\0object-format=sha256`);
    expect(parseCloudReceiveCommand(bytes, ref, 64).newOid).toBe("b".repeat(64));
    expect(() => parseCloudReceiveCommand(bytes, ref, 40)).toThrow();
  });
  it.each(["../main", "x/y", "", "x.lock", "run\nmain"])("rejects unsafe run identity", id => {
    expect(() => cloudReturnRef("codex-cloud", id)).toThrow();
  });
});
