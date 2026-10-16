import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { getConfig } from "../config.js";

export interface TriggerPatterns {
  strong: RegExp[];
  weak: RegExp[];
  negative: RegExp[];
}

const DEFAULT_PATTERNS_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "trigger-patterns.json",
);

export function loadPatterns(
  path = getConfig().patternsPath ?? DEFAULT_PATTERNS_PATH,
): TriggerPatterns | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    strong?: string[];
    weak?: string[];
    negative?: string[];
  };
  const compile = (list?: string[]) =>
    (list ?? [])
      .filter((s) => {
        if (typeof s !== "string") return false;
        try {
          new RegExp(s, "i");
          return true;
        } catch {
          log(`invalid pattern skipped: ${s}`, "error");
          return false;
        }
      })
      .map((s) => new RegExp(s, "i"));
  return {
    strong: compile(raw.strong),
    weak: compile(raw.weak),
    negative: compile(raw.negative),
  };
}

export function matchesTrigger(text: string, patterns: TriggerPatterns): boolean {
  for (const re of patterns.negative) if (re.test(text)) return false;
  for (const re of patterns.strong) if (re.test(text)) return true;
  for (const re of patterns.weak) if (re.test(text)) return true;
  return false;
}
