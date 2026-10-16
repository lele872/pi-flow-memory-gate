import type { DecisionAnswers } from "../decision/answers.js";

import { getConfig } from "../config.js";

const config = getConfig();
const SECRET_THRESHOLD = config.secretThreshold;
const SESSION_THRESHOLD = config.sessionThreshold;
const DURABLE_THRESHOLD = config.durableThreshold;
const FAILURE_THRESHOLD = config.failureThreshold;
const IMPORTANCE_THRESHOLD = config.importanceThreshold;
const IMPORTANCE_MIN = config.importanceMin;

export interface VetoResult {
  allowed: boolean;
  reason?: string;
}

export function checkVetoes(answers: DecisionAnswers): VetoResult {
  const secret = answers.has_secret?.noul ?? 0;
  if (secret >= SECRET_THRESHOLD) {
    return { allowed: false, reason: `secret=${secret.toFixed(2)}` };
  }
  const session = answers.is_session_scoped?.noul ?? 0;
  if (session >= SESSION_THRESHOLD) {
    return { allowed: false, reason: `session-scoped=${session.toFixed(2)}` };
  }
  return { allowed: true };
}

export function isCandidate(answers: DecisionAnswers): boolean {
  const target = answers.target?.choice;
  if (!target || target === "none") return false;
  const durable = answers.is_durable?.noul ?? 0;
  const failure = answers.is_failure?.noul ?? 0;
  const importance = answers.importance?.score ?? 0;
  if (failure >= FAILURE_THRESHOLD) return true;
  if (importance >= IMPORTANCE_THRESHOLD) return true;
  return durable >= DURABLE_THRESHOLD && importance >= IMPORTANCE_MIN;
}
