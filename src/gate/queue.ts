import type { DecisionAnswers } from "../decision/answers.js";

export interface Candidate {
  state: string;
  answers: DecisionAnswers;
  logits: Record<string, Record<string, number>>;
  queuedAt: number;
}

import { getConfig } from "../config.js";

const MAX_QUEUE = getConfig().maxQueue;

let queue: Candidate[] = [];

export function enqueue(candidate: Candidate): boolean {
  const duplicate = queue.some(
    (c) => c.state === candidate.state || similar(c.state, candidate.state),
  );
  if (duplicate) return false;
  queue.push(candidate);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  return true;
}

export function getQueue(): Candidate[] {
  return queue;
}

export function clearQueue(indices: number[]): void {
  queue = queue.filter((_, i) => !indices.includes(i));
}

function similar(a: string, b: string): boolean {
  const first = a.split("\n")[0].slice(0, 120);
  const second = b.split("\n")[0].slice(0, 120);
  if (first.length < 20 || second.length < 20) return first === second;
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
  const ta = tokens(first);
  const tb = tokens(second);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.8;
}
