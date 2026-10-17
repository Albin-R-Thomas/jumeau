import { createHash } from "node:crypto";
export const NORMALIZATION_VERSION = 1;
export function normalize(query: string): string {
  return query
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\s*,\s*/gu, ",")
    .toLowerCase();
}
export const queryHash = (query: string) =>
  createHash("sha256").update(normalize(query)).digest("hex");
