import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decisionModelHealth } from "./decision/client.js";
import { runReview } from "./review.js";
import { reviewQueue, getReviewMode, type ApprovedCandidate } from "./gate/review-ui.js";
import { getTriggerMode, type TriggerMode } from "./gate/trigger.js";
import { matchesTrigger, loadPatterns, type TriggerPatterns } from "./gate/patterns.js";
import { createSynthesizer } from "./memory/synthesize.js";
import { createStandaloneSink, buildEntry } from "./memory/sink.js";
import { consolidate } from "./memory/consolidate.js";
import { calibrationRowCount } from "./gate/calib-log.js";
import { log, bindUI } from "./log.js";

import { getConfig } from "./config.js";

const CALIB_NOTIFY_THRESHOLD = getConfig().calibThreshold;

const REVIEW_INTERVAL = getConfig().interval;
const TRIGGER_MODE: TriggerMode = getTriggerMode();

let turnCount = 0;
let patterns: TriggerPatterns | null = null;
let currentModelId: string | null = null;

function trackModel(ctx: { model?: { id?: string; provider?: string } | null }): void {
  if (ctx.model?.id) {
    currentModelId = ctx.model.provider
      ? `${ctx.model.provider}/${ctx.model.id}`
      : ctx.model.id;
  }
}

function shouldTrigger(ctx: {
  sessionManager: { getEntries: () => unknown[] };
}): boolean {
  if (TRIGGER_MODE === "always") return true;
  if (TRIGGER_MODE === "interval") {
    turnCount++;
    return turnCount % REVIEW_INTERVAL === 0;
  }
  const lastUserText = extractLastUserText(ctx);
  if (!lastUserText) return false;
  if (!patterns) patterns = loadPatterns();
  if (!patterns) return true;
  return matchesTrigger(lastUserText, patterns);
}

function extractLastUserText(ctx: {
  sessionManager: { getEntries: () => unknown[] };
}): string | null {
  const entries = ctx.sessionManager.getEntries() as {
    type: string;
    message?: { role?: string; content?: unknown };
  }[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const raw = entry.message.content;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) {
      const parts = raw
        .filter(
          (p) =>
            p &&
            typeof p === "object" &&
            "text" in p &&
            typeof (p as { text?: unknown }).text === "string",
        )
        .map((p) => (p as { text: string }).text);
      if (parts.length > 0) return parts.join("\n");
    }
    return null;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  const synthesizer = createSynthesizer(async (cmd, args) => {
    const res = await pi.exec(cmd, args);
    return { stdout: res.stdout };
  });
  const sink = createStandaloneSink();

  async function handleApproved(candidate: ApprovedCandidate): Promise<void> {
    const target = candidate.answers.target?.choice ?? "memory";
    const entries = await synthesizer.synthesize(
      { state: candidate.state, target },
      currentModelId,
    );
    for (const entry of entries) {
      sink.save(
        buildEntry(entry.content, entry.target, candidate.answers, candidate.state),
      );
    }
  }

  let calibNotified = false;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      bindUI(ctx.ui);
      log("ui bound (session_start)");
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.hasUI) bindUI(ctx.ui);
    trackModel(ctx);
    if (!shouldTrigger(ctx)) return;
    await runReview(ctx);
    if (getReviewMode() === "auto") {
      await reviewQueue(ctx.ui, handleApproved);
    }
    if (!calibNotified && calibrationRowCount() >= CALIB_NOTIFY_THRESHOLD) {
      calibNotified = true;
      const msg = `[memory-gate] calibration ready: ${calibrationRowCount()} rows logged. Time to refit — /gate-status for details.`;
      log(msg);
      ctx.ui.notify(msg, "info");
    }
  });

  pi.on("model_select", (event) => {
    currentModelId = event.model.provider
      ? `${event.model.provider}/${event.model.id}`
      : event.model.id;
  });

  pi.registerCommand("gate-status", {
    description: "Memory gate status: decision model connection and config",
    handler: async (_args, ctx) => {
      const h = await decisionModelHealth();
      const rows = calibrationRowCount();
      const mode = h.ok ? "info" : "warning";
      const msg = h.ok
        ? `Decision model up (${h.detail}) — trigger=${TRIGGER_MODE}, review=${getReviewMode()}, calibration=${rows}/${CALIB_NOTIFY_THRESHOLD} rows`
        : `Decision model unreachable (${h.detail}). Gate stays silent.`;
      ctx.ui.notify(msg, mode);
    },
  });

  pi.registerCommand("memory-review", {
    description: "Review queued memory candidates and approve them",
    handler: async (_args, ctx) => {
      await reviewQueue(ctx.ui, handleApproved);
    },
  });

  pi.registerCommand("memory-consolidate", {
    description:
      "Compact stored memories: decision model drops irrelevant entries and duplicates",
    handler: async (_args, ctx) => {
      try {
        await consolidate(
          async (a, b) => {
            const prompt = `Merge these two memory entries into one. Rules: 1-2 sentences, plain text, keep ALL concrete details from both, same language, no markdown.\nEntry 1: ${a.content}\nEntry 2: ${b.content}\nMerged entry:`;
            const args = ["-p", "--no-session"];
            if (currentModelId) args.push("--model", currentModelId);
            args.push(prompt);
            try {
              const res = await pi.exec("pi", args);
              const text = res.stdout.trim();
              if (!text || text.length > 600) return null;
              return { ...a, content: text, createdAt: new Date().toISOString() };
            } catch {
              return null;
            }
          },
          (msg) => ctx.ui.notify(msg, "info"),
        );
      } catch (e) {
        ctx.ui.notify(
          `Consolidation failed: ${e instanceof Error ? e.message : String(e)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("gate-review", {
    description: "Run a memory gate review now, ignoring the trigger mode",
    handler: async (_args, ctx) => {
      await runReview(ctx);
    },
  });
}
