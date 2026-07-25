/**
 * Normalizes a user-pasted file path: trims whitespace and strips one layer
 * of matching surrounding quotes. Windows Explorer's "Copy as path" wraps
 * paths in double quotes (e.g. `"C:\Users\me\data.csv"`); pasted as-is, the
 * quotes become part of the string and break extension checks / existence
 * checks downstream.
 */
export function normalizeUserPath(input: string): string {
  let value = input.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}
