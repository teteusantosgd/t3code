import { ProjectReadFileError, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Schema from "effect/Schema";
import { applyEdits, modify } from "jsonc-parser";

export type RepositorySettings = NonNullable<T3ProjectFile["repositories"]>;
const isReadError = Schema.is(ProjectReadFileError);

function errnoCode(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return undefined;
}

export function isMissingProjectConfig(error: unknown): boolean {
  if (
    !isReadError(error) ||
    error.failure !== "operation_failed" ||
    (error.operation !== "realpath-target" && error.operation !== "open")
  ) {
    return false;
  }
  const code = errnoCode(error.cause);
  // Wire-decoded Defects often drop errno codes. A failed realpath/open of t3.json
  // is almost always "file does not exist yet"; keep explicit non-ENOENT codes as errors.
  return code === undefined || code === "ENOENT";
}

export function parseRepositoryPaths(text: string): string[] {
  const paths = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (paths.length > 100) throw new Error("Use at most 100 repository paths.");
  for (const path of paths) {
    const directory = path.endsWith("/*") ? path.slice(0, -2) : path;
    const isCheckoutRoot = directory === "." || directory === "";
    const hasPathSegment = directory
      .split("/")
      .some((segment) => segment !== "" && segment !== ".");
    if (
      (!isCheckoutRoot && !hasPathSegment) ||
      path.length > 512 ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      /[*?[]/.test(directory)
    ) {
      throw new Error(
        `Invalid repository path: ${path}. Use a relative path (including ../siblings), ".", or a trailing /*, such as apps/*.`,
      );
    }
  }
  return paths;
}

export function updateRepositoryConfig(contents: string, settings: RepositorySettings): string {
  if (parseT3ProjectFile(contents) === null) {
    throw new Error("Fix the invalid t3.json before saving repository settings.");
  }
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: contents.includes("\r\n") ? "\r\n" : "\n",
  };
  let next = contents;
  for (const [key, value] of Object.entries(settings)) {
    next = applyEdits(next, modify(next, ["repositories", key], value, { formattingOptions }));
  }
  return next;
}
