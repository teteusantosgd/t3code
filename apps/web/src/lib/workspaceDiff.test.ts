import { describe, expect, it } from "vite-plus/test";

import { filterWorkspaceDiffRepositories } from "./workspaceDiff";

describe("filterWorkspaceDiffRepositories", () => {
  const repositories = [
    { path: "HSpotWeb", name: "HSpotWeb", cwd: "/p/HSpotWeb", available: true },
    { path: "Radius", name: "Radius", cwd: "/p/Radius", available: true },
  ];

  it("keeps every repository for All repos", () => {
    expect(filterWorkspaceDiffRepositories(repositories, null)).toEqual(repositories);
  });

  it("keeps only the selected repository", () => {
    expect(filterWorkspaceDiffRepositories(repositories, "Radius")).toEqual([repositories[1]]);
  });
});
