/**
 * Path helpers for creating a workspace file from the Files tree context menu.
 * Directory rows create inside themselves; file rows create beside the file.
 */

export function resolveNewFileDirectory(item: {
  readonly kind: "directory" | "file";
  readonly path: string;
}): string {
  const normalized = item.path.replace(/\/$/, "");
  if (item.kind === "directory") return normalized;
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex);
}

/**
 * Joins a directory ("" for project root) with a user-entered name. Rejects
 * empty names, absolute paths, and `..` segments so create cannot escape the
 * workspace relative to the chosen directory.
 */
export function buildNewWorkspaceFilePath(directoryPath: string, rawName: string): string | null {
  const trimmed = rawName.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return null;

  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;

  const relativeName = segments.join("/");
  return directoryPath ? `${directoryPath}/${relativeName}` : relativeName;
}
