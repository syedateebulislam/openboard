/**
 * skeletonRegions — the biller-specific slots inside a reference fetcher.
 *
 * Biller Studio used to hand the model a whole fetcher and ask for a whole
 * fetcher back. Measured on fetch_zomato.py, ~78% of that output is the model
 * retyping the shared helpers, the runner and the CLI — text already sitting on
 * disk. On a local model at ~16 tok/s that is the difference between 195s and
 * 43s of generation, and it is why a request could be severed mid-file.
 *
 * The skeletons now carry marker comments around the parts that actually differ
 * per biller. The model returns only those, and OpenBoard splices them into its
 * own copy of the skeleton — so the boilerplate is ours, not model-authored,
 * and the assembled file still goes through every existing check.
 *
 * Markers are comments, so a marked fetcher remains ordinary Python and still
 * runs standalone.
 *
 * Everything here is pure: no filesystem, no model.
 */

/** `# <<OPENBOARD:NAME>>` … `# <</OPENBOARD:NAME>>`, captured per region. */
const REGION_PATTERN = /^[ \t]*# <<OPENBOARD:([A-Z0-9_]+)>>[ \t]*\r?\n([\s\S]*?)^[ \t]*# <<\/OPENBOARD:\1>>[ \t]*$/gm;

/** Any opening or closing marker, used to catch the unpaired ones. */
const ANY_MARKER = /^[ \t]*# <<\/?OPENBOARD:([A-Z0-9_]+)>>[ \t]*$/gm;

export interface SkeletonRegion {
  name: string;
  /** The text between the markers, markers excluded. */
  body: string;
  /** Offsets of `body` within the skeleton. */
  start: number;
  end: number;
}

/**
 * Every marked region, in the order it appears.
 *
 * Throws rather than returning a partial result: a skeleton with an unpaired
 * marker would otherwise splice into a file that is silently missing a chunk,
 * and the first sign of it would be a Python syntax error much further along.
 */
export function parseRegions(skeleton: string): SkeletonRegion[] {
  const regions: SkeletonRegion[] = [];
  const seen = new Set<string>();

  REGION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REGION_PATTERN.exec(skeleton)) !== null) {
    const [full, name, body] = match;
    if (seen.has(name)) {
      throw new Error(`Skeleton declares the region ${name} more than once.`);
    }
    seen.add(name);
    regions.push({
      name,
      body,
      start: match.index + full.indexOf(body),
      end: match.index + full.indexOf(body) + body.length,
    });
  }

  // Count the raw markers too: a region whose closing tag is missing or
  // misspelled simply fails to match the pair pattern, and would otherwise
  // vanish without complaint.
  ANY_MARKER.lastIndex = 0;
  const markerCount = (skeleton.match(ANY_MARKER) ?? []).length;
  if (markerCount !== regions.length * 2) {
    throw new Error(
      `Skeleton has ${markerCount} region markers but ${regions.length} complete region(s) — one is unpaired or misspelled.`,
    );
  }

  return regions;
}

/** Region names this skeleton declares, in order — what to ask the model for. */
export function regionNames(skeleton: string): string[] {
  return parseRegions(skeleton).map((region) => region.name);
}

/**
 * Rebuild the skeleton with the supplied bodies in place of the marked ones.
 *
 * Replacements are applied last-first so earlier offsets stay valid. A name the
 * skeleton does not declare is refused: silently dropping it would hand back a
 * file missing the code the model was asked to write.
 *
 * Regions left out keep the skeleton's own body, which is what makes a partial
 * reply recoverable instead of fatal.
 */
export function spliceRegions(skeleton: string, replacements: Map<string, string>): string {
  const regions = parseRegions(skeleton);
  const declared = new Set(regions.map((region) => region.name));

  for (const name of replacements.keys()) {
    if (!declared.has(name)) {
      throw new Error(
        `No region named ${name} in this skeleton. It declares: ${[...declared].join(', ')}.`,
      );
    }
  }

  let result = skeleton;
  for (const region of [...regions].reverse()) {
    const replacement = replacements.get(region.name);
    if (replacement === undefined) continue;
    const eol = skeleton.includes('\r\n') ? '\r\n' : '\n';
    // Normalise to the skeleton's line endings so a model that answers with LF
    // does not leave a CRLF file mixed.
    let normalised = eol === '\r\n'
      ? replacement.replace(/\r?\n/g, '\r\n')
      : replacement.replace(/\r\n/g, '\n');

    // The captured body ends with the newline before the closing marker, and a
    // model's reply usually will not. Without restoring it the marker lands on
    // the last line of the body — still valid Python, since it becomes a
    // comment, but it survives the marker stripper and litters the file.
    if (!normalised.endsWith(eol)) normalised += eol;

    result = result.slice(0, region.start) + normalised + result.slice(region.end);
  }
  return result;
}

/** Strip the markers, for a file that should read as ordinary Python. */
export function stripRegionMarkers(source: string): string {
  return source.replace(/^[ \t]*# <<\/?OPENBOARD:[A-Z0-9_]+>>[ \t]*\r?\n/gm, '');
}
