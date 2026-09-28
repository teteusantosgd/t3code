import { describe, expect, it } from "vite-plus/test";

import { buildNewWorkspaceFilePath, resolveNewFileDirectory } from "./newWorkspaceFile";

describe("resolveNewFileDirectory", () => {
  it("uses the directory itself", () => {
    expect(resolveNewFileDirectory({ kind: "directory", path: "apps/web/" })).toBe("apps/web");
    expect(resolveNewFileDirectory({ kind: "directory", path: "apps/web" })).toBe("apps/web");
  });

  it("uses the parent of a file, including the project root", () => {
    expect(resolveNewFileDirectory({ kind: "file", path: "apps/web/main.tsx" })).toBe("apps/web");
    expect(resolveNewFileDirectory({ kind: "file", path: "README.md" })).toBe("");
  });
});

describe("buildNewWorkspaceFilePath", () => {
  it("joins a simple name under a directory or the root", () => {
    expect(buildNewWorkspaceFilePath("apps/web", "notes.md")).toBe("apps/web/notes.md");
    expect(buildNewWorkspaceFilePath("", "notes.md")).toBe("notes.md");
  });

  it("allows nested relative segments and normalizes separators", () => {
    expect(buildNewWorkspaceFilePath("src", "features/foo.ts")).toBe("src/features/foo.ts");
    expect(buildNewWorkspaceFilePath("src", "features\\foo.ts")).toBe("src/features/foo.ts");
  });

  it("rejects empty, absolute, and escaping names", () => {
    expect(buildNewWorkspaceFilePath("src", "   ")).toBeNull();
    expect(buildNewWorkspaceFilePath("src", "/etc/passwd")).toBeNull();
    expect(buildNewWorkspaceFilePath("src", "C:\\Windows\\a.ts")).toBeNull();
    expect(buildNewWorkspaceFilePath("src", "../escape.ts")).toBeNull();
    expect(buildNewWorkspaceFilePath("src", "foo/../bar.ts")).toBeNull();
    expect(buildNewWorkspaceFilePath("src", ".")).toBeNull();
  });
});
