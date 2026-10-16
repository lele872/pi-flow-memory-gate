import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "../decision/client.js";
import type { Questionnaire } from "../decision/types.js";
import type { MemoryEntry } from "./sink.js";

import { getConfig } from "../config.js";

const config = getConfig();
const GATE_DIR = config.memoryDir;
const RELEVANT_THRESHOLD = config.relevantThreshold;
const SAME_FACT_THRESHOLD = config.sameFactThreshold;
const HARD_DROP_THRESHOLD = config.hardDropThreshold;
const PAIR_JACCARD_MIN = config.pairJaccardMin;

function loadQuestionnaire(path: string, fallbackPath: string): Questionnaire {
  const resolved = path || join(import.meta.dirname, "..", "..", fallbackPath);
  const raw = JSON.parse(readFileSync(resolved, "utf-8"));
  const out: Questionnaire = {};
  for (const [name, q] of Object.entries(raw as Record<string, unknown>)) {
    if (
      q &&
      typeof q === "object" &&
      typeof (q as { instructions?: unknown }).instructions === "string" &&
      (q as { type?: unknown }).type
    ) {
      out[name] = q as Questionnaire[string];
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`no valid questions in ${resolved}`);
  }
  return out;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function containment(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export interface ConsolidationReport {
  total: number;
  kept: number;
  droppedIrrelevant: number;
  droppedDuplicate: number;
  merged: number;
  details: string[];
}

export function isRawFallback(entry: MemoryEntry): boolean {
  const rawFirst = entry.raw
    ?.split("\n")[0]
    ?.replace(/^user:\s*/, "")
    ?.trim();
  return !!rawFirst && rawFirst === entry.content;
}

export async function consolidate(
  mergeEntries: (a: MemoryEntry, b: MemoryEntry) => Promise<MemoryEntry | null>,
  log: (msg: string) => void,
): Promise<ConsolidationReport> {
  const jsonlPath = join(GATE_DIR, "memories.jsonl");
  const mdPath = join(GATE_DIR, "MEMORY.md");
  if (!existsSync(jsonlPath)) {
    throw new Error(`no memories at ${jsonlPath}`);
  }
  const entries: MemoryEntry[] = readFileSync(jsonlPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemoryEntry);
  const report: ConsolidationReport = {
    total: entries.length,
    kept: 0,
    droppedIrrelevant: 0,
    droppedDuplicate: 0,
    merged: 0,
    details: [],
  };

  const singleQ = loadQuestionnaire(
    config.consolidateQuestionsPath ?? "",
    "consolidate-questions.json",
  );
  const pairQ = loadQuestionnaire(
    config.pairQuestionsPath ?? "",
    "consolidate-pair-questions.json",
  );

  const alive: MemoryEntry[] = [];
  for (const entry of entries) {
    const answers = await decide(entry.content, singleQ);
    const relevant = answers?.still_relevant?.noul ?? 1;
    if (relevant < RELEVANT_THRESHOLD) {
      report.droppedIrrelevant++;
      report.details.push(
        `drop (irrelevant ${relevant.toFixed(2)}): ${entry.content.slice(0, 60)}`,
      );
      continue;
    }
    alive.push(entry);
  }

  const survivors: MemoryEntry[] = [];
  const emitted = new Set<MemoryEntry>();
  const removed = new Set<number>();
  for (let i = 0; i < alive.length; i++) {
    if (removed.has(i)) continue;
    let current = alive[i];
    for (let j = i + 1; j < alive.length; j++) {
      if (removed.has(j)) continue;
      const sim = Math.max(
        jaccard(current.content, alive[j].content),
        containment(current.content, alive[j].content),
      );
      if (sim < PAIR_JACCARD_MIN) continue;
      const state = `Entry A: ${current.content}\n\nEntry B: ${alive[j].content}`;
      const answers = await decide(state, pairQ);
      const sameFact = answers?.same_fact?.noul ?? 0;
      if (sameFact < SAME_FACT_THRESHOLD) continue;
      const merged = await mergeEntries(current, alive[j]);
      if (merged) {
        report.merged++;
        report.details.push(
          `merged (same_fact ${sameFact.toFixed(2)}): ${current.content.slice(0, 40)} + ${alive[j].content.slice(0, 40)}`,
        );
        current = merged;
        removed.add(j);
      } else {
        if (sameFact < HARD_DROP_THRESHOLD) {
          report.details.push(
            `kept both (same_fact ${sameFact.toFixed(2)}, merge unavailable, below hard drop)`,
          );
          continue;
        }
        const aRaw = isRawFallback(current);
        const bRaw = isRawFallback(alive[j]);
        let keepA: boolean;
        if (aRaw !== bRaw) {
          keepA = !aRaw;
        } else {
          keepA = current.createdAt >= alive[j].createdAt;
        }
        const loser = keepA ? alive[j] : current;
        const winner = keepA ? current : alive[j];
        report.droppedDuplicate++;
        report.details.push(
          `duplicate (same_fact ${sameFact.toFixed(2)}): dropped "${loser.content.slice(0, 50)}"`,
        );
        current = winner;
        if (keepA) removed.add(j);
        else removed.add(i);
      }
    }
    if (!emitted.has(current)) {
      emitted.add(current);
      survivors.push(current);
    }
  }

  report.kept = survivors.length;
  if (survivors.length < entries.length) {
    copyFileSync(jsonlPath, jsonlPath + ".bak");
    if (existsSync(mdPath)) copyFileSync(mdPath, mdPath + ".bak");
    writeFileSync(jsonlPath, survivors.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(
      mdPath,
      "# Memory Gate\n\n" +
        survivors.map((e) => `- [${e.target}] ${e.content}`).join("\n") +
        "\n",
    );
    log(
      `[memory-gate] consolidated: ${report.total} -> ${report.kept} (${report.droppedIrrelevant} irrelevant, ${report.droppedDuplicate} duplicates, ${report.merged} merged). Backup: .bak`,
    );
  } else {
    log(`[memory-gate] consolidation: nothing to compact (${report.total} entries)`);
  }
  return report;
}
