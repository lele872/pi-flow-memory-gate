export type TriggerMode = "always" | "interval" | "patterns";

import { getConfig } from "../config.js";

export function getTriggerMode(): TriggerMode {
  return getConfig().trigger;
}
