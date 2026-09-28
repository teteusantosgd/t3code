import { describe, expect, it } from "vite-plus/test";

import {
  configuredDiffRepositories,
  expandConfiguredRepositoryPaths,
  repositoriesFromRepoRoots,
  resolveConfiguredRepositoryCwd,
} from "./configuredRepositories";

describe("configuredRepositories", () => {
  it("resolves nested and sibling repository cwds from the workspace root", () => {
    expect(resolveConfiguredRepositoryCwd("/proj", "HSpotWeb")).toBe("/proj/HSpotWeb");
    expect(resolveConfiguredRepositoryCwd("/proj/", ".")).toBe("/proj");
    expect(resolveConfiguredRepositoryCwd("/work/HSpotWeb", "../Radius")).toBe("/work/Radius");
    expect(resolveConfiguredRepositoryCwd("/work/HSpotWeb", "projects/../Radius")).toBe(
      "/work/HSpotWeb/Radius",
    );
    expect(resolveConfiguredRepositoryCwd("/proj", "/abs")).toBeNull();
  });

  it("builds sibling repositories when t3.json uses ../ paths", () => {
    expect(
      configuredDiffRepositories({
        workspaceRoot: "/work/HSpotWeb",
        projectFile: {
          repositories: { paths: [".", "../Radius", "../Services"] },
        },
        listChildren: () => [],
      }),
    ).toEqual([
      { path: ".", name: "HSpotWeb", cwd: "/work/HSpotWeb" },
      { path: "../Radius", name: "Radius", cwd: "/work/Radius" },
      { path: "../Services", name: "Services", cwd: "/work/Services" },
    ]);
  });

  it("expands trailing /* patterns from immediate children", () => {
    expect(
      expandConfiguredRepositoryPaths(["apps/*", "Services"], (directory) =>
        directory === "apps" ? ["web", "api"] : [],
      ),
    ).toEqual(["apps/web", "apps/api", "Services"]);
  });

  it("maps absolute repo roots to diff repositories with unique cwds", () => {
    expect(repositoriesFromRepoRoots(["/work/repo-a", "/work/repo-b", "/work/repo-a/"])).toEqual([
      { path: "/work/repo-a", name: "repo-a", cwd: "/work/repo-a" },
      { path: "/work/repo-b", name: "repo-b", cwd: "/work/repo-b" },
    ]);
  });

  it("builds named repositories from t3.json paths", () => {
    expect(
      configuredDiffRepositories({
        workspaceRoot: "/work/hspot",
        projectFile: {
          repositories: { paths: ["HSpotWeb", "Radius", "missing/*"] },
        },
        listChildren: (directory) => (directory === "missing" ? [] : []),
      }),
    ).toEqual([
      { path: "HSpotWeb", name: "HSpotWeb", cwd: "/work/hspot/HSpotWeb" },
      { path: "Radius", name: "Radius", cwd: "/work/hspot/Radius" },
    ]);
  });
});
