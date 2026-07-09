export const OPENBRAIN_LOADER_BEGIN_MARKER = "<!-- openbrain:begin -->";
export const OPENBRAIN_LOADER_END_MARKER = "<!-- openbrain:end -->";

export const DEFAULT_LOADER_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
] as const;

export type LoaderFilename = (typeof DEFAULT_LOADER_FILENAMES)[number];
