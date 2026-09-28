import { LRUCache } from "./lruCache";

let nextDiagramId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

// Cap by entry count and ~2 MiB of SVG text so scroll-back reuse stays cheap.
const renderedDiagrams = new LRUCache<string>(50, 2 * 1024 * 1024);

function cacheKey(code: string, theme: "light" | "dark"): string {
  return `${theme}\0${code}`;
}

/** Mermaid uses global configuration, so initialize and render each diagram together. */
export function renderMermaidDiagram(code: string, theme: "light" | "dark"): Promise<string> {
  const key = cacheKey(code, theme);
  const cached = renderedDiagrams.get(key);
  if (cached != null) {
    return Promise.resolve(cached);
  }

  const result = renderQueue.then(async () => {
    const hit = renderedDiagrams.get(key);
    if (hit != null) {
      return hit;
    }
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    });
    const { svg } = await mermaid.render(`chat-mermaid-${++nextDiagramId}`, code);
    renderedDiagrams.set(key, svg, svg.length * 2);
    return svg;
  });
  renderQueue = result.catch(() => undefined);
  return result;
}
