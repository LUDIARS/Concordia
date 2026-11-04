import { isDeepStrictEqual } from "node:util";

/** Independently check both acceptance and rejection of lock snapshots. */
export default {
  post(result, before, after) {
    const expected = structuredClone(before);
    const qs = expected.packages?.["node_modules/qs"];
    if (qs?.version !== "6.16.0") return result === false;
    qs.version = "6.16.2";
    qs.resolved = "https://registry.npmjs.org/qs/-/qs-6.16.2.tgz";
    qs.integrity = "sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA==";
    return result === isDeepStrictEqual(expected, after);
  },
};
