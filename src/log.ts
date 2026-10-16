import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "event" | "error" | "debug";

import { getConfig } from "./config.js";

const config = getConfig();
const GATE_DIR = config.memoryDir;
const WIDGET_KEY = "memory-gate";
const WIDGET_LINES = 8;
const DEBUG = config.debug;
const MODE = config.tuiLog;

interface UI {
  setWidget: (key: string, content: string[] | undefined, options?: object) => void;
  notify: (msg: string, kind: "info" | "warning") => void;
}

let ui: UI | null = null;
let hasUI = false;
const buffer: string[] = [];

export function bindUI(u: UI): void {
  ui = u;
  hasUI = true;
  render();
}

export function log(msg: string, level: LogLevel = "event"): void {
  if (level === "debug" && !DEBUG) return;
  const line = level === "error" ? `! ${msg}` : msg;
  buffer.push(line);
  if (buffer.length > WIDGET_LINES) buffer.splice(0, buffer.length - WIDGET_LINES);
  toFile(`${new Date().toISOString()} [${level}] ${msg}`);
  render(msg, level);
}

function render(msg?: string, level: LogLevel = "event"): void {
  if (!hasUI) {
    if (msg && level !== "debug") console.log(`[memory-gate] ${msg}`);
    return;
  }
  if (!ui) return;
  if (MODE === "off") return;
  if (MODE === "notify") {
    if (msg && level !== "debug") {
      ui.notify(`[memory-gate] ${msg}`, level === "error" ? "warning" : "info");
    }
    return;
  }
  ui.setWidget(WIDGET_KEY, ["memory-gate", ...buffer]);
}

function toFile(line: string): void {
  try {
    mkdirSync(GATE_DIR, { recursive: true });
    appendFileSync(join(GATE_DIR, "gate.log"), line + "\n");
  } catch {
    // logging must never break the gate
  }
}
