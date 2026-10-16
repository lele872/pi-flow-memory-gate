import { decisionModelHealth, decideNative } from "./decision/client.js";
import { getQuestions } from "./decision/questions.js";
import { checkVetoes, isCandidate } from "./gate/filter.js";
import { enqueue } from "./gate/queue.js";
import { logDecision } from "./gate/calib-log.js";
import { getReviewMode } from "./gate/review-ui.js";
import { log } from "./log.js";

import { getConfig } from "./config.js";

const config = getConfig();
const REVIEW_INTERVAL = config.interval;
const REVIEW_WINDOW = config.window;
const MAX_STATE_CHARS = 1200;

interface CollectedMessage {
  role: "user" | "assistant";
  text: string;
  entryIndex: number;
}

let lastReviewedIndex = -1;

export function collectRecentMessages(
  entries: { type: string; message?: { role?: string; content?: unknown } }[],
): CollectedMessage[] {
  const out: CollectedMessage[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role: string = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const raw = entry.message.content;
    const parts: string[] = [];
    if (typeof raw === "string") {
      parts.push(raw);
    } else if (Array.isArray(raw)) {
      for (const p of raw) {
        if (
          p &&
          typeof p === "object" &&
          "text" in p &&
          typeof (p as { text?: unknown }).text === "string"
        ) {
          parts.push((p as { text: string }).text);
        }
      }
    }
    const text = parts.join("\n").trim();
    if (text) out.push({ role: role as "user" | "assistant", text, entryIndex: index });
  }
  return out.slice(-REVIEW_WINDOW);
}

export function buildStates(
  messages: CollectedMessage[],
): { state: string; entryIndex: number }[] {
  const states: { state: string; entryIndex: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    const user = messages[i];
    const assistant =
      i + 1 < messages.length && messages[i + 1].role === "assistant"
        ? messages[i + 1].text.slice(0, MAX_STATE_CHARS / 2)
        : "";
    const state = `${user.role}: ${user.text}\nassistant: ${assistant}`.slice(
      0,
      MAX_STATE_CHARS,
    );
    if (state.trim().length > 40) states.push({ state, entryIndex: user.entryIndex });
  }
  return states;
}

export async function runReview(
  ctx: {
    sessionManager: { getEntries: () => unknown[] };
    ui: { notify: (msg: string, kind: "info" | "warning") => void };
  },
  options?: { silent?: boolean },
): Promise<void> {
  const health = await decisionModelHealth();
  if (!health.ok) {
    log(`decision model unreachable: ${health.detail}`, "error");
    return;
  }
  const entries = ctx.sessionManager.getEntries() as {
    type: string;
    message?: { role?: string; content?: unknown };
  }[];
  const messages = collectRecentMessages(entries);
  const newStates = buildStates(messages).filter((s) => s.entryIndex > lastReviewedIndex);
  if (newStates.length === 0) return;
  const states = newStates.slice(-REVIEW_INTERVAL);

  const questions = getQuestions();
  const reviewMode = getReviewMode();
  let passed = 0;
  let vetoed = 0;
  let queued = 0;
  for (const { state } of states) {
    const result = await decideNative(state, questions);
    if (!result) continue;
    const { answers, logits } = result;
    const veto = checkVetoes(answers);
    if (!veto.allowed) {
      vetoed++;
      log(`vetoed (${veto.reason})`);
      logDecision({ answers, logits, outcome: "vetoed", reviewMode }, state);
      continue;
    }
    passed++;
    if (!isCandidate(answers)) {
      logDecision({ answers, logits, outcome: "filtered", reviewMode }, state);
      continue;
    }
    if (enqueue({ state, answers, logits, queuedAt: Date.now() })) queued++;
  }
  lastReviewedIndex = Math.max(lastReviewedIndex, ...newStates.map((s) => s.entryIndex));
  log(
    `review: ${states.length} judged, ${passed} passed veto, ${vetoed} vetoed, ${queued} queued`,
  );
  if (queued > 0 && !options?.silent) {
    ctx.ui.notify(
      `[memory-gate] ${queued} new candidate(s) queued. Run /memory-review to approve.`,
      "info",
    );
  }
}
