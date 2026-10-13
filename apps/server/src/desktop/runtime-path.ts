/** 把运行时 bin 目录前置到既有 PATH（去重：已含则不加）。 */
export function prependRuntimePath(
  existingPath: string | undefined,
  additions: readonly string[],
  separator = ";",
): string {
  const parts = (existingPath ?? "")
    .split(separator)
    .filter((part) => part.length > 0);
  const missing = additions.filter((dir) => !parts.includes(dir));
  return [...missing, ...parts].join(separator);
}
