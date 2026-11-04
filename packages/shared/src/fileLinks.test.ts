import { describe, expect, it } from "vite-plus/test";
import {
  fileLinkRecovery,
  parseFileUrlHref,
  splitFilePathPosition,
  resolvePathLinkTarget,
} from "./fileLinks.ts";

describe("fileLinkRecovery", () => {
  it("reopens only a unique candidate from a complete search", () => {
    expect(
      fileLinkRecovery(
        {
          failure: "file_not_found",
          candidates: ["repo/src/file.ts"],
          candidatesTruncated: false,
        },
        "src/file.ts",
      ).automaticPath,
    ).toBe("repo/src/file.ts");
  });

  it.each([
    { failure: "file_not_found", candidates: [], candidatesTruncated: false },
    {
      failure: "file_not_found",
      candidates: ["repo/file.ts", "worktree/file.ts"],
      candidatesTruncated: false,
    },
    { failure: "file_not_found", candidates: ["repo/file.ts"], candidatesTruncated: true },
    { failure: "file_not_found", candidates: ["repo/file.ts"] },
    { failure: "operation_failed", candidates: ["repo/file.ts"], candidatesTruncated: false },
    { failure: "binary_file", candidates: ["repo/file.ts"], candidatesTruncated: false },
    {},
    null,
  ])(
    "does not choose automatically with ambiguity, partial data, or another failure: %j",
    (error) => {
      expect(fileLinkRecovery(error, "file.ts").automaticPath).toBeNull();
    },
  );

  it.each([
    "/outside/file.ts",
    "C:\\outside\\file.ts",
    "~/file.ts",
    "~\\file.ts",
    "../file.ts",
    "repo/../file.ts",
    "./file.ts",
    "file.ts",
    "",
  ])("rejects unsafe or self-referencing candidate %s", (candidate) => {
    const recovery = fileLinkRecovery(
      {
        failure: "file_not_found",
        candidates: [candidate],
        candidatesTruncated: false,
      },
      "file.ts",
    );
    expect(recovery.candidates).toEqual([]);
    expect(recovery.automaticPath).toBeNull();
  });

  it("does not hide ambiguity by filtering or deduplicating bad server suggestions", () => {
    for (const candidates of [
      ["repo/file.ts", "../file.ts"],
      ["repo/file.ts", "repo/file.ts"],
    ]) {
      expect(
        fileLinkRecovery(
          {
            failure: "file_not_found",
            candidates,
            candidatesTruncated: false,
          },
          "file.ts",
        ).automaticPath,
      ).toBeNull();
    }
  });
});

describe("parseFileUrlHref", () => {
  it.each([
    ["file:///Users/julius/project/src/main.ts#L42", "/Users/julius/project/src/main.ts", "#L42"],
    [
      "file:///D:/Programme/t3code/OpenInPicker.tsx#L69",
      "D:/Programme/t3code/OpenInPicker.tsx",
      "#L69",
    ],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg", ""],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md", ""],
  ])("parses %s", (href, path, hash) => {
    expect(parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("keeps percent-encoding so the caller decodes once", () => {
    expect(parseFileUrlHref("file:///Users/julius/project/file%2520name.md")?.path).toBe(
      "/Users/julius/project/file%2520name.md",
    );
    expect(parseFileUrlHref("file:///c%3A/Users/x/shot.png")?.path).toBe("/c%3A/Users/x/shot.png");
  });

  it.each(["https://example.com/a.ts", "file://%", "/Users/julius/a.ts"])("rejects %s", (href) => {
    expect(parseFileUrlHref(href)).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts", "", { path: "src/main.ts" }],
    ["src/main.ts:12", "", { path: "src/main.ts", line: 12 }],
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
    ["src/main.ts", "#section", { path: "src/main.ts" }],
  ])("splits %s%s", (path, hash, expected) => {
    expect(splitFilePathPosition(path, hash)).toEqual(expected);
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  it.each([
    ["C:\\Users\\julius\\project", "C:\\Users\\julius\\notes.md:3"],
    ["C:/Users/julius/project", "C:/Users/julius\\notes.md:3"],
  ])("resolves home paths against the Windows cwd %s", (cwd, expected) => {
    expect(resolvePathLinkTarget("~/notes.md:3", cwd)).toBe(expected);
  });
});
