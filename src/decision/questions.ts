import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDecisionQuestionType, type Questionnaire } from "./types.js";
import { log } from "../log.js";

import { getConfig } from "../config.js";

const config = getConfig();
const QUESTIONS_PATH =
  config.questionsPath ?? join(import.meta.dirname, "..", "..", "gate-questions.json");

function parse(raw: string): Questionnaire {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Questionnaire = {};
  for (const [name, q] of Object.entries(parsed)) {
    if (
      q &&
      typeof q === "object" &&
      isDecisionQuestionType((q as { type?: unknown }).type) &&
      typeof (q as { instructions?: unknown }).instructions === "string"
    ) {
      out[name] = q as Questionnaire[string];
    } else {
      log(`skipping invalid question: ${name}`, "error");
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`no valid questions in ${QUESTIONS_PATH}`);
  }
  return out;
}

let cached: Questionnaire | null = null;

export function getQuestions(): Questionnaire {
  if (!cached) cached = parse(readFileSync(QUESTIONS_PATH, "utf-8"));
  return cached;
}
