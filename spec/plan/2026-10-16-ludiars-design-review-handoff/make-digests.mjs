// Historical entry point; implementation and regression coverage live in tooling.
import { makeDigests } from "../../../tools/design-review/make-digests.mjs";
for (const name of makeDigests(process.argv.slice(2))) process.stdout.write(`${name}\n`);