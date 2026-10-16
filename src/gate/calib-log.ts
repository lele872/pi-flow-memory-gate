import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DecisionAnswers } from "../decision/answers.js";
import { log } from "../log.js";

import { getConfig } from "../config.js";

const LOG_PATH = join(getConfig().memoryDir, "calibration.jsonl");

export type Outcome = "approved" | "discarded" | "filtered" | "vetoed";

export interface CalibInput {
  answers: DecisionAnswers;
  logits: Record<string, Record<string, number>>;
  outcome: Outcome;
  reviewMode: string;
}

export interface CalibRecord extends CalibInput {
  ts: string;
  state: string;
  stateExcerpt: string;
}

export function logDecision(rec: CalibInput, fullState?: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const record: CalibRecord = {
      ...rec,
      ts: new Date().toISOString(),
      state: fullState ?? "",
      stateExcerpt: (fullState ?? "").split("\n")[0].slice(0, 150),
    };
    appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
  } catch (e) {
    log(`calibration log failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export function calibrationRowCount(): number {
  if (!existsSync(LOG_PATH)) return 0;
  return readFileSync(LOG_PATH, "utf-8")
    .split("\n")
    .filter((l) => l.trim()).length;
}
