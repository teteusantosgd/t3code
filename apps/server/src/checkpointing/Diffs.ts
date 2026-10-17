export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

// Operating-system metadata is never a project change, but it is untracked in
// repos without a matching ignore rule, so a checkpoint would otherwise report
// a lone `.DS_Store` as the turn's only file.
const OS_METADATA_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** Whether a changed path is operating-system metadata rather than project content. */
export function isOsMetadataPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/);
  const basename = segments[segments.length - 1] ?? "";
  return OS_METADATA_BASENAMES.has(basename.toLowerCase());
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    if (path.length === 0) {
      // Renames and copies use two more records: the source and destination.
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;
    if (isOsMetadataPath(path)) continue;

    files.push({
      path,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}
