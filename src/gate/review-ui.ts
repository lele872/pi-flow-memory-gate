import type { Candidate } from "./queue";
import { getQueue, clearQueue } from "./queue";
import { logDecision } from "./calib-log";

export type ReviewMode = "confirm" | "auto" | "off";

import { getConfig } from "../config.js";

export function getReviewMode(): ReviewMode {
  return getConfig().reviewMode;
}

export interface ApprovedCandidate extends Candidate {
  approvedAt: number;
}

interface ReviewUI {
  confirm: (
    title: string,
    message: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<boolean>;
  notify: (msg: string, kind: "info" | "warning") => void;
}

export async function reviewQueue(
  ui: ReviewUI,
  onApprove: (candidate: ApprovedCandidate) => Promise<void>,
): Promise<void> {
  const mode = getReviewMode();
  const queue = getQueue();
  if (queue.length === 0) {
    ui.notify("[memory-gate] queue is empty", "info");
    return;
  }
  if (mode === "off") {
    clearQueue(queue.map((_, i) => i));
    return;
  }

  const approved: number[] = [];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const ok = mode === "auto" ? true : await confirmCandidate(ui, c);
    if (ok) {
      approved.push(i);
      logDecision(
        { answers: c.answers, logits: c.logits, outcome: "approved", reviewMode: mode },
        c.state,
      );
      await onApprove({ ...c, approvedAt: Date.now() });
    } else {
      logDecision(
        { answers: c.answers, logits: c.logits, outcome: "discarded", reviewMode: mode },
        c.state,
      );
    }
  }
  clearQueue(queue.map((_, i) => i));
  ui.notify(
    `[memory-gate] review done: ${approved.length} approved, ${queue.length - approved.length} discarded`,
    "info",
  );
}

async function confirmCandidate(ui: ReviewUI, c: Candidate): Promise<boolean> {
  const target = c.answers.target?.choice ?? "?";
  const durable = c.answers.is_durable?.noul ?? 0;
  const failure = c.answers.is_failure?.noul ?? 0;
  const importance = c.answers.importance?.score ?? 0;
  const preview = c.state.split("\n")[0].slice(0, 100);
  return ui.confirm(
    "Save memory?",
    `[${target}] durable=${durable.toFixed(2)} failure=${failure.toFixed(2)} importance=${importance.toFixed(1)}\n  "${preview}"`,
  );
}
