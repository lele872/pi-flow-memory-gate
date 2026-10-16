import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface GateConfig {
  decisionModelUrl: string;
  decisionModelId: string;
  trigger: "always" | "interval" | "patterns";
  interval: number;
  window: number;
  questionsPath: string | null;
  patternsPath: string | null;
  secretThreshold: number;
  sessionThreshold: number;
  durableThreshold: number;
  failureThreshold: number;
  importanceThreshold: number;
  importanceMin: number;
  maxQueue: number;
  reviewMode: "confirm" | "auto" | "off";
  synthesize: boolean;
  synthPromptPath: string | null;
  memoryDir: string;
  relevantThreshold: number;
  sameFactThreshold: number;
  hardDropThreshold: number;
  pairJaccardMin: number;
  consolidateQuestionsPath: string | null;
  pairQuestionsPath: string | null;
  calibThreshold: number;
  tuiLog: "widget" | "notify" | "off";
  debug: boolean;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "memory-gate-config.json");

const DEFAULTS: GateConfig = {
  decisionModelUrl: "http://127.0.0.1:8017",
  decisionModelId: "rizzo-latest",
  trigger: "always",
  interval: 10,
  window: 20,
  questionsPath: null,
  patternsPath: null,
  secretThreshold: 0.5,
  sessionThreshold: 0.8,
  durableThreshold: 0.5,
  failureThreshold: 0.5,
  importanceThreshold: 2.5,
  importanceMin: 1.5,
  maxQueue: 20,
  reviewMode: "confirm",
  synthesize: true,
  synthPromptPath: null,
  memoryDir: join(AGENT_DIR, "memory-gate"),
  relevantThreshold: 0.5,
  sameFactThreshold: 0.55,
  hardDropThreshold: 0.7,
  pairJaccardMin: 0.3,
  consolidateQuestionsPath: null,
  pairQuestionsPath: null,
  calibThreshold: 200,
  tuiLog: "notify",
  debug: false,
};

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveNumber(v: unknown): v is number {
  return isNumber(v) && v > 0;
}

function loadFileConfig(): Record<string, unknown> {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    console.error(
      `[memory-gate] invalid ${CONFIG_PATH}, ignoring: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}

function applyEnv(config: GateConfig): GateConfig {
  const env = process.env;
  if (env.DECISION_MODEL_URL) config.decisionModelUrl = env.DECISION_MODEL_URL;
  if (env.DECISION_MODEL_ID) config.decisionModelId = env.DECISION_MODEL_ID;
  if (env.GATE_TRIGGER) {
    const v = env.GATE_TRIGGER;
    if (v === "always" || v === "interval" || v === "patterns") config.trigger = v;
  }
  if (isPositiveNumber(Number(env.GATE_INTERVAL)))
    config.interval = Number(env.GATE_INTERVAL);
  if (isPositiveNumber(Number(env.GATE_WINDOW))) config.window = Number(env.GATE_WINDOW);
  if (env.GATE_QUESTIONS_PATH) config.questionsPath = env.GATE_QUESTIONS_PATH;
  if (env.GATE_PATTERNS_PATH) config.patternsPath = env.GATE_PATTERNS_PATH;
  if (isNumber(Number(env.GATE_SECRET_THRESHOLD)))
    config.secretThreshold = Number(env.GATE_SECRET_THRESHOLD);
  if (isNumber(Number(env.GATE_SESSION_THRESHOLD)))
    config.sessionThreshold = Number(env.GATE_SESSION_THRESHOLD);
  if (isNumber(Number(env.GATE_DURABLE_THRESHOLD)))
    config.durableThreshold = Number(env.GATE_DURABLE_THRESHOLD);
  if (isNumber(Number(env.GATE_FAILURE_THRESHOLD)))
    config.failureThreshold = Number(env.GATE_FAILURE_THRESHOLD);
  if (isNumber(Number(env.GATE_IMPORTANCE_THRESHOLD)))
    config.importanceThreshold = Number(env.GATE_IMPORTANCE_THRESHOLD);
  if (isNumber(Number(env.GATE_IMPORTANCE_MIN)))
    config.importanceMin = Number(env.GATE_IMPORTANCE_MIN);
  if (isPositiveNumber(Number(env.GATE_MAX_QUEUE)))
    config.maxQueue = Number(env.GATE_MAX_QUEUE);
  if (env.GATE_REVIEW_MODE) {
    const v = env.GATE_REVIEW_MODE;
    if (v === "confirm" || v === "auto" || v === "off") config.reviewMode = v;
  }
  if (env.GATE_SYNTHESIZE) config.synthesize = env.GATE_SYNTHESIZE !== "false";
  if (env.GATE_SYNTH_PROMPT_PATH) config.synthPromptPath = env.GATE_SYNTH_PROMPT_PATH;
  if (env.GATE_MEMORY_DIR) config.memoryDir = env.GATE_MEMORY_DIR;
  if (isNumber(Number(env.GATE_RELEVANT_THRESHOLD)))
    config.relevantThreshold = Number(env.GATE_RELEVANT_THRESHOLD);
  if (isNumber(Number(env.GATE_SAME_FACT_THRESHOLD)))
    config.sameFactThreshold = Number(env.GATE_SAME_FACT_THRESHOLD);
  if (isNumber(Number(env.GATE_HARD_DROP_THRESHOLD)))
    config.hardDropThreshold = Number(env.GATE_HARD_DROP_THRESHOLD);
  if (isNumber(Number(env.GATE_PAIR_JACCARD_MIN)))
    config.pairJaccardMin = Number(env.GATE_PAIR_JACCARD_MIN);
  if (env.GATE_CONSOLIDATE_QUESTIONS_PATH)
    config.consolidateQuestionsPath = env.GATE_CONSOLIDATE_QUESTIONS_PATH;
  if (env.GATE_PAIR_QUESTIONS_PATH)
    config.pairQuestionsPath = env.GATE_PAIR_QUESTIONS_PATH;
  if (isPositiveNumber(Number(env.GATE_CALIB_THRESHOLD)))
    config.calibThreshold = Number(env.GATE_CALIB_THRESHOLD);
  if (env.GATE_TUI_LOG) {
    const v = env.GATE_TUI_LOG;
    if (v === "widget" || v === "notify" || v === "off") config.tuiLog = v;
  }
  if (env.GATE_DEBUG === "1") config.debug = true;
  return config;
}

function applyFile(config: GateConfig, file: Record<string, unknown>): void {
  const setNum = (key: keyof GateConfig, value: unknown, positive = false): void => {
    if (positive ? isPositiveNumber(value) : isNumber(value)) {
      (config[key] as number) = value as number;
    }
  };
  if (typeof file.decisionModelUrl === "string")
    config.decisionModelUrl = file.decisionModelUrl;
  if (typeof file.decisionModelId === "string")
    config.decisionModelId = file.decisionModelId;
  if (
    file.trigger === "always" ||
    file.trigger === "interval" ||
    file.trigger === "patterns"
  )
    config.trigger = file.trigger;
  setNum("interval", file.interval, true);
  setNum("window", file.window, true);
  if (typeof file.questionsPath === "string") config.questionsPath = file.questionsPath;
  if (typeof file.patternsPath === "string") config.patternsPath = file.patternsPath;
  setNum("secretThreshold", file.secretThreshold);
  setNum("sessionThreshold", file.sessionThreshold);
  setNum("durableThreshold", file.durableThreshold);
  setNum("failureThreshold", file.failureThreshold);
  setNum("importanceThreshold", file.importanceThreshold);
  setNum("importanceMin", file.importanceMin);
  setNum("maxQueue", file.maxQueue, true);
  if (
    file.reviewMode === "confirm" ||
    file.reviewMode === "auto" ||
    file.reviewMode === "off"
  )
    config.reviewMode = file.reviewMode;
  if (typeof file.synthesize === "boolean") config.synthesize = file.synthesize;
  if (typeof file.synthPromptPath === "string")
    config.synthPromptPath = file.synthPromptPath;
  if (typeof file.memoryDir === "string") config.memoryDir = file.memoryDir;
  setNum("relevantThreshold", file.relevantThreshold);
  setNum("sameFactThreshold", file.sameFactThreshold);
  setNum("hardDropThreshold", file.hardDropThreshold);
  setNum("pairJaccardMin", file.pairJaccardMin);
  if (typeof file.consolidateQuestionsPath === "string")
    config.consolidateQuestionsPath = file.consolidateQuestionsPath;
  if (typeof file.pairQuestionsPath === "string")
    config.pairQuestionsPath = file.pairQuestionsPath;
  setNum("calibThreshold", file.calibThreshold, true);
  if (file.tuiLog === "widget" || file.tuiLog === "notify" || file.tuiLog === "off")
    config.tuiLog = file.tuiLog;
  if (typeof file.debug === "boolean") config.debug = file.debug;
}

let cached: GateConfig | null = null;

export function getConfig(): GateConfig {
  if (cached) return cached;
  const config: GateConfig = { ...DEFAULTS };
  applyFile(config, loadFileConfig());
  cached = applyEnv(config);
  return cached;
}

export function configSource(): string {
  return CONFIG_PATH;
}
