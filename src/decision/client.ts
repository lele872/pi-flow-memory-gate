import type { DecisionAnswers } from "./answers.js";
import type { DecisionQuestion, Questionnaire } from "./types.js";
import { log } from "../log.js";

import { getConfig } from "../config.js";

const config = getConfig();

export async function decisionModelHealth(): Promise<{
  ok: boolean;
  detail?: string;
}> {
  try {
    const res = await fetch(`${config.decisionModelUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: string };
    return { ok: body.status === "ready", detail: body.status };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function decide(
  state: string,
  questions: Questionnaire,
): Promise<DecisionAnswers | null> {
  try {
    const res = await fetch(`${config.decisionModelUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.decisionModelId,
        state,
        questions,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      log(`decision model HTTP ${res.status}`, "error");
      return null;
    }
    const body = (await res.json()) as { answers?: DecisionAnswers };
    return body.answers ?? null;
  } catch (e) {
    log(`decision model error: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }
}

export interface NativeDecision {
  answers: DecisionAnswers;
  logits: Record<string, Record<string, number>>;
}

interface NativeQuestion {
  type: string;
  instructions: string;
  policy?: { allow_abstain: boolean };
  options?: { id: string; description?: string }[];
  levels?: string[];
}

interface NativeAnswer {
  type: string;
  probabilities?: Record<string, number>;
  score?: number;
  option_logits?: Record<string, number>;
}

function toNative(q: DecisionQuestion): NativeQuestion {
  const base: NativeQuestion = {
    type: q.type,
    instructions: q.instructions,
    policy: { allow_abstain: false },
  };
  if (q.type === "choice" && q.criteria && !Array.isArray(q.criteria)) {
    base.options = Object.entries(q.criteria).map(([id, desc]) => ({
      id,
      description: desc ?? undefined,
    }));
  }
  if (q.type === "score" && Array.isArray(q.criteria)) {
    base.levels = q.criteria;
  }
  if (q.type === "noul") {
    base.type = "boolean";
  }
  return base;
}

export async function decideNative(
  state: string,
  questions: Questionnaire,
): Promise<NativeDecision | null> {
  const native: Record<string, NativeQuestion> = {};
  for (const [name, q] of Object.entries(questions)) {
    native[name] = toNative(q);
  }
  try {
    const res = await fetch(`${config.decisionModelUrl}/v1/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, questions: native }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      log(`decision model HTTP ${res.status}`, "error");
      return null;
    }
    const body = (await res.json()) as { answers: Record<string, NativeAnswer> };
    const answers: DecisionAnswers = {};
    const logits: Record<string, Record<string, number>> = {};
    for (const [name, a] of Object.entries(body.answers)) {
      logits[name] = a.option_logits ?? {};
      if (a.type === "boolean") {
        answers[name] = { noul: a.probabilities?.true ?? 0 };
      } else if (a.type === "choice") {
        const probs = a.probabilities ?? {};
        const choice = Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0];
        answers[name] = { choice, probabilities: probs };
      } else if (a.type === "score") {
        answers[name] = { score: a.score ?? 0, probabilities: a.probabilities };
      }
    }
    return { answers, logits };
  } catch (e) {
    log(`decision model error: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }
}
