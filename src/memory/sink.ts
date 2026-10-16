import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAnswers } from "../decision/answers.js";
import { log } from "../log.js";

import { getConfig } from "../config.js";

const GATE_DIR = getConfig().memoryDir;

export interface MemoryEntry {
  content: string;
  target: string;
  createdAt: string;
  scores: {
    durable: number;
    failure: number;
    secret: number;
    sessionScoped: number;
    importance: number;
  };
  raw: string;
}

export interface MemorySink {
  save(entry: MemoryEntry): void;
}

export function createStandaloneSink(): MemorySink {
  return {
    save(entry: MemoryEntry): void {
      mkdirSync(GATE_DIR, { recursive: true });
      appendFileSync(join(GATE_DIR, "memories.jsonl"), JSON.stringify(entry) + "\n");
      const mdLine = `- [${entry.target}] ${entry.content}\n`;
      const mdPath = join(GATE_DIR, "MEMORY.md");
      if (!existsSync(mdPath)) {
        appendFileSync(mdPath, "# Memory Gate\n\n" + mdLine);
      } else {
        appendFileSync(mdPath, mdLine);
      }
      log(`saved [${entry.target}] ${entry.content.slice(0, 80)}`);
    },
  };
}

export function buildEntry(
  content: string,
  target: string,
  answers: DecisionAnswers,
  raw: string,
): MemoryEntry {
  return {
    content,
    target,
    createdAt: new Date().toISOString(),
    scores: {
      durable: answers.is_durable?.noul ?? 0,
      failure: answers.is_failure?.noul ?? 0,
      secret: answers.has_secret?.noul ?? 0,
      sessionScoped: answers.is_session_scoped?.noul ?? 0,
      importance: answers.importance?.score ?? 0,
    },
    raw,
  };
}
