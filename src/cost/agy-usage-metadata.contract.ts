import { agyInteger, agyMessage, readAgyWire } from "./agy-usage-wire.js";

export default {
  post(result: unknown, data: Uint8Array): boolean {
    const usage = agyMessage(agyMessage(readAgyWire(data), 1), 4);
    const expected = [2, 5, 3, 9].map((field) => agyInteger(usage, field) ?? 0);
    const sum = expected[0] + expected[1] + expected[2];
    if (!Number.isSafeInteger(sum) || sum === 0 || expected[3] > expected[2]) return result === null;
    if (result === null) return false;
    const { input, cached, output, thinking, total } = result as Record<string, number>;
    return [input, cached, output, thinking].every((n, index) => n === expected[index]) && total === sum;
  },
};
