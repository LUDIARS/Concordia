/** Keep registry lists inside Discord limits and make any truncation explicit. */
export function clipProjectCodeList(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  const suffix = "\n…(一覧の一部を省略)";
  if (suffix.length >= maxLength) return suffix.slice(0, maxLength);
  return `${value.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}
