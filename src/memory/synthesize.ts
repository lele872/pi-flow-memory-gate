import { readFileSync } from "node:fs";
import { log } from "../log.js";

import { getConfig } from "../config.js";

const SYNTH_ENABLED = getConfig().synthesize;

const VALID_TARGETS = new Set(["user", "memory", "project", "failure"]);

const DEFAULT_PROMPT = `The following conversation excerpt contains one or more distinct durable facts. Extract each one as a separate memory entry.
Rules:
- one line per memory entry, format: [category] text
- category is exactly one of: user, memory, project, failure
- 1 sentence per entry, plain text, no markdown, no quotes
- keep concrete details (paths, commands, names, versions, constraints)
- drop corrections framing, greetings, temporary instructions, and anything scoped to one session
- write in the same language as the excerpt
Suggested category: {target}

Excerpt:
{state}

Memory entries:`;

export interface SynthEntry {
  content: string;
  target: string;
}

export interface Synthesizer {
  synthesize(
    input: { state: string; target: string },
    modelId: string | null,
  ): Promise<SynthEntry[]>;
}

function loadPrompt(): string {
  const path = getConfig().synthPromptPath;
  if (!path) return DEFAULT_PROMPT;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    log(`cannot read synth prompt at ${path}, using default`, "error");
    return DEFAULT_PROMPT;
  }
}

export function createSynthesizer(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string }>,
): Synthesizer {
  return {
    async synthesize(input, modelId): Promise<SynthEntry[]> {
      const fallback: SynthEntry[] = [
        {
          content: input.state
            .split("\n")[0]
            .replace(/^user:\s*/, "")
            .trim(),
          target: input.target,
        },
      ];
      if (!SYNTH_ENABLED) return fallback;
      const prompt = loadPrompt()
        .replace("{target}", input.target)
        .replace("{state}", input.state.slice(0, 2000));
      const args = ["-p", "--no-session"];
      if (modelId) args.push("--model", modelId);
      args.push(prompt);
      try {
        const res = await exec("pi", args);
        const entries = parseEntries(res.stdout, input.target);
        return entries.length > 0 ? entries : fallback;
      } catch (e) {
        log(
          `synthesis failed, saving raw: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return fallback;
      }
    },
  };
}

export function parseEntries(stdout: string, fallbackTarget: string): SynthEntry[] {
  const entries: SynthEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^\[([a-z]+)\]\s*(.+)$/i);
    if (!match) continue;
    const rawTarget = match[1].toLowerCase();
    const content = match[2].trim();
    if (!content || content.length > 600) continue;
    const target = VALID_TARGETS.has(rawTarget)
      ? rawTarget
      : VALID_TARGETS.has(fallbackTarget)
        ? fallbackTarget
        : "memory";
    entries.push({ content, target });
  }
  return entries;
}
