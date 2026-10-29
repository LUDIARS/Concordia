/** @implements spec/feature/line-webhook-relay.md — お知らせの push (line-wh-C-19) */
interface TargetShape { name: string; channel: string; enabled: boolean; pushEnabled: boolean }
interface LinkShape { channel: string; talkId: string; service: string; isDefault: boolean }
type Result =
  | { kind: "talks"; channel: string; talkIds: string[] }
  | { kind: "skipped"; reason: string };

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const targets = args[0] as readonly TargetShape[];
    const links = args[1] as readonly LinkShape[];
    const service = args[2];
    if (!Array.isArray(targets) || !Array.isArray(links) || typeof service !== "string") return false;
    const outcome = result as Result;
    const target = targets.find((candidate) => candidate.name === service);
    // Nothing is pushed unless the service is registered, running and allowed to push.
    if (!target || !target.enabled || !target.pushEnabled) return outcome?.kind === "skipped";
    if (outcome?.kind !== "talks" || outcome.channel !== target.channel) return false;
    const expected = new Set(links
      .filter((link) => link.channel === target.channel && link.service === service && link.isDefault)
      .map((link) => link.talkId));
    return new Set(outcome.talkIds).size === outcome.talkIds.length
      && outcome.talkIds.length === expected.size
      && outcome.talkIds.every((talkId) => expected.has(talkId));
  },
};
