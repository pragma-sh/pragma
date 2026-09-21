/** Converts a directory or package name into a valid lowercase npm package name. */
export function normalizePluginName(input: string): string {
  const name = input
    .trim()
    .replace(/^@/, "")
    .replaceAll(/[^a-zA-Z0-9._~-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
  return name || "pragma-plugin";
}
