export const DENYLIST: string[];
export const OPEN_REQUIRED: string[];
export const STORE_REQUIRED: string[];
export const ALLOWLIST: Array<{ why: string; pattern: RegExp }>;
export function findHits(text: string, file: string): Array<{ file: string; term: string; context: string }>;
export function scanDirectory(dir: string): { hits: Array<{ file: string; term: string; context: string }>; corpus: string };
export function check(args: { dir: string; mode: "store" | "open" }): string[];
export function nativeProblems(mode: "store" | "open", root?: string): string[];
