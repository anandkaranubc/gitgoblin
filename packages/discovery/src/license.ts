const PERMISSIVE = new Set([
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "bsd-3-clause-clear",
  "isc",
  "unlicense",
  "0bsd",
  "zlib",
  "bsl-1.0",
  "cc0-1.0",
  "mpl-2.0",
  "artistic-2.0",
  "postgresql",
  "ncsa",
  "wtfpl",
  "mit-0",
  "upl-1.0",
]);
const COPYLEFT_PREFIXES = ["gpl-", "lgpl-", "agpl-", "epl-", "eupl-", "cecill", "osl-", "cc-by-sa", "ms-rl", "ofl-"];

export interface LicenseAssessment {
  /** 0 none, 0.4 custom or unrecognized, 0.75 copyleft, 1 permissive. */
  score: number;
  label: string;
}

/** Classifies an SPDX identifier (any case) or GitHub's "NOASSERTION". */
export function assessLicense(spdx: string | undefined): LicenseAssessment {
  if (!spdx) return { score: 0, label: "no license" };
  const id = spdx.trim().toLowerCase();
  if (id === "" || id === "none") return { score: 0, label: "no license" };
  if (id === "noassertion" || id === "other") return { score: 0.4, label: "custom license" };
  if (PERMISSIVE.has(id)) return { score: 1, label: `${spdx} (permissive)` };
  if (COPYLEFT_PREFIXES.some((prefix) => id.startsWith(prefix))) return { score: 0.75, label: `${spdx} (copyleft)` };
  return { score: 0.6, label: spdx };
}
