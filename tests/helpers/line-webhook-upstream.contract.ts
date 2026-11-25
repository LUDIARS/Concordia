import type { RelayInput } from "../../src/line-webhook/relay.js";
import type { LineTestUpstream } from "./line-webhook-upstream.js";

export default {
  post(result: unknown, input: RelayInput, upstream: LineTestUpstream): boolean {
    const recorded = upstream.received.at(-1);
    return recorded?.headers === input.headers &&
      JSON.stringify(recorded.body) === Buffer.from(input.body).toString("utf8") &&
      result != null;
  },
};
