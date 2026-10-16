# pi-flow-memory-gate

An extension for [Pi](https://pi.dev) that manages agent memory with a **local decision model**: a small language model running on your own machine decides, on every turn, what is worth remembering — **without spending a single token of the main model**.

Designed to work alongside `pi-hermes-memory` (which stays active for search, session indexing, and secret scanning) but replacing its auto-memory loop: instead of the main LLM reviewing the conversation every N turns, a decision model at ~0.3 seconds per judgment does the selection, and you approve.

```
turn end → decision model judges (0 LLM tokens)
         → vetoes: never propose secrets or session-scoped instructions
         → candidates → your confirmation (or auto)
         → LLM synthesis: clean rewrite, split into multiple memories
         → saved to local files (jsonl + Markdown)
         → periodic consolidation: decision model drops duplicates and stale entries
         → every decision is logged → calibration data
```

## Why

The bottleneck of classic auto-memory is **selection**: a large LLM reading dozens of messages to decide what to save. This project moves selection to a decision model (the reference implementation is [Rizzo Flow](https://github.com/Rizzo-AI-Academy/rizzo-flow), 4B, compatible with the `/v1/systemone` interface) that runs locally and answers in a few hundred milliseconds with typed probabilities — no generated text, no parsing, no format hallucinations. The main model is involved only for the last two steps, and only on what you already approved:

| Stage | Who | Cost |
|---|---|---|
| Judgment (durable? secret? category?) | decision model | ~0.3s, 0 tokens |
| Veto (secrets, session-scoped instructions) | decision model | 0 tokens |
| Approval | you (or thresholds in auto) | 30s occasionally |
| Synthesis + split into memories | LLM, approved items only | a few tokens |
| Consolidation (drop/dedup) | decision model | 0 tokens |
| Real merges (rare) | LLM | a few tokens |

## Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Decision model setup](#decision-model-setup)
- [Features](#features)
- [Commands](#commands)
- [Environment variables (overrides)](#environment-variables-overrides)
- [Configuration files](#configuration-files)
- [Project structure](#project-structure)
- [Calibration](#calibration)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [License](#license)

## Installation

Requirements: Pi with extension support, a decision model reachable over HTTP (see below), Node/npm for development.

```bash
pi install git:github.com/youruser/pi-flow-memory-gate
# or, once published on npm:
pi install npm:pi-flow-memory-gate

# development: load the extension directly
pi --extension ~/pi-flow-memory-gate
```

## Configuration

Configuration lives in a JSON file: `~/.pi/agent/memory-gate-config.json` (create it if missing; without a file, defaults apply). Every key is optional:

```jsonc
{
  "decisionModelUrl": "http://127.0.0.1:8017",
  "decisionModelId": "rizzo-latest",
  "trigger": "always",              // always | interval | patterns
  "reviewMode": "confirm",          // confirm | auto | off
  "tuiLog": "notify",               // notify | widget | off
  "memoryDir": "~/.pi/agent/memory-gate",
  "secretThreshold": 0.5,
  "durableThreshold": 0.5
}
```

Three layers, in increasing priority:

1. **defaults** hardcoded in the code
2. **`memory-gate-config.json`** — the stable configuration of your setup
3. **environment variables** — temporary overrides, ideal for tests and experiments (full table below)

Invalid values in the JSON are ignored with a warning: a typo never breaks the gate.

## Decision model setup

The extension is generic: it points at any server exposing `/health`, `/v1/systemone` (compatible format) and `/v1/decisions` (native endpoint, for logits). The development reference is Rizzo Flow:

```bash
git clone https://github.com/Rizzo-AI-Academy/rizzo-flow && cd rizzo-flow
uv sync --locked --extra mlx        # on Apple Silicon; other hardware, see their README
uv run rizzo download --backend mlx
uv run rizzo serve --backend mlx --bits 8 --calibration fit.json
```

Then:

```bash
export DECISION_MODEL_URL=http://127.0.0.1:8017
```

If the decision model is down, the gate goes silent (one log line) and does nothing: Pi keeps working normally.

## Features

### 1. End-of-turn evaluation

On every `turn_end` the extension collects recent user/assistant messages, builds one *state* per user message (with the assistant reply that follows), and submits it to the decision model with the configurable questionnaire. Each message is judged **exactly once** (a cursor over the session position), so turn retries never produce duplicate judgments.

Three trigger modes (config `trigger`):

- `always` (default) — evaluate every turn: maximum coverage, cost is ~0.3s per turn end
- `interval` — evaluate every `interval` turns (classic background-review style)
- `patterns` — evaluate only if the last user message matches a configurable regex (`patternsPath`, file `trigger-patterns.json`, a strong/weak/negative structure inspired by pi-hermes-memory's correction detectors, Italian patterns included); if the file is missing, it degrades to `always`

### 2. Hard vetoes

Two categories are never proposed, decided by the decision model before even entering the queue:

- **secrets**: passwords, API keys, tokens (`has_secret` ≥ `secretThreshold`). Note: a *pointer* to a secret ("the password is in .env") is not the secret itself — it is not vetoed
- **session-scoped instructions**: explicitly temporary preferences ("for this session use the large model", `is_session_scoped` ≥ `sessionThreshold`)

### 3. Candidate selection

Past the vetoes, a state enters the queue if `target ≠ none` and at least one of:

- `is_failure` ≥ `failureThreshold` (lessons learned pass on their own)
- `importance` ≥ `importanceThreshold`
- `is_durable` ≥ `durableThreshold` **and** `importance` ≥ `importanceMin` (conjunctive: a single weak signal is not enough)

The queue has deduplication (identical or 80%+ similar on first line and tokens) and a cap (`maxQueue`).

### 4. Approval: confirm, auto, or off

`reviewMode` (config) / `GATE_REVIEW_MODE` (env):

- `confirm` (default) — `/memory-review` command: a yes/no dialog for each candidate with category, scores, and preview. Every choice you make is a calibration label
- `auto` — everything passing vetoes and thresholds is saved without asking (full auto-memory)
- `off` — the gate observes and logs, saves nothing

### 5. Synthesis and split into multiple memories

Each approved candidate goes to an LLM (the **current chat model**, captured automatically and updated if you switch models mid-session) which:

- rewrites it as 1-2 dense sentences, in the style of a memory bank (concrete details yes, greetings and framing no, same language as the excerpt)
- **extracts distinct facts**: a message containing two different memories becomes two separate entries, each with its own category (e.g. `[failure]` for a lesson, `[memory]` for an environment fact) — and per-fact categorization turns out to be more accurate than per-message
- the prompt is configurable (`gate-synth-prompt.txt` via `synthPromptPath`, placeholders `{target}` and `{state}`)

If the model is unreachable, fallback: the raw first line is saved (better raw than lost).

### 6. Standalone storage

Approved memories land in `~/.pi/agent/memory-gate/` (configurable via `memoryDir`):

- `memories.jsonl` — full record: synthesized content, category, timestamp, raw decision-model scores, original state
- `MEMORY.md` — readable export: one `- [category] memory` line per entry

### 7. Consolidation

The `/memory-consolidate` command. Three phases, almost all at zero cost:

1. for each entry: `still_relevant` on the decision model — below threshold, dropped (0 tokens)
2. for each suspicious pair (Jaccard + containment token similarity): `same_fact` on the decision model — if it is the same fact, keep the synthesized one (or the newer) and drop the other (0 tokens)
3. only genuine merges (similar but complementary facts) go to the LLM, which fuses them preserving all details (a few tokens)

Built-in caution: without an available LLM, a hard drop requires high certainty (`hardDropThreshold`, default 0.7); borderline cases are left for the next round. Before rewriting the files, a `.bak` backup is created.

### 8. Calibration logging

Every gate decision (approved, discarded, filtered, vetoed) is logged to `~/.pi/agent/memory-gate/calibration.jsonl` with the decision model's **raw logits** (via the native `/v1/decisions` endpoint), the scores, the outcome, and the state. That file is the dataset to refit the decision model's temperatures — see [Calibration](#calibration). The counter is visible in `/gate-status` (`87/200 rows`); when the threshold is reached (`calibThreshold`), a once-per-session notification fires.

### 9. TUI logging

All gate messages are rendered by Pi, never written raw to the terminal (config `tuiLog`):

- `notify` (default) — transient popup per event
- `widget` — persistent panel above the editor with the last 8 event lines
- `off` — file only

In all cases everything also lands in `~/.pi/agent/memory-gate/gate.log` (with timestamp and level), and in headless mode (`pi -p`, SDK) output goes to the console.

## Commands

| Command | What it does |
|---|---|
| `/gate-status` | Status: decision model connection, active modes, calibration rows |
| `/memory-review` | Reviews queued candidates: confirmation dialog for each (`confirm` mode) |
| `/gate-review` | Forces an evaluation now, ignoring the trigger mode |
| `/memory-consolidate` | Compacts saved memories (drop irrelevant and duplicates, merge) |

## Environment variables (overrides)

Environment variables override the JSON configuration file: they are meant for tests, quick experiments, and temporary overrides — not as the stable configuration (use `memory-gate-config.json` for that). Each variable maps to a config JSON key, shown in the second column. Unrecognized variables or invalid values are ignored.

### Connection and general behavior

| Variable | Config key | Default | Description |
|---|---|---|---|
| `DECISION_MODEL_URL` | `decisionModelUrl` | `http://127.0.0.1:8017` | Decision model endpoint |
| `DECISION_MODEL_ID` | `decisionModelId` | `rizzo-latest` | Model id passed to the API |
| `GATE_MEMORY_DIR` | `memoryDir` | `~/.pi/agent/memory-gate` | Data directory (memories, logs, calibration) |
| `GATE_DEBUG` | `debug` | `false` | `1` = debug log (full scores) to file |

### Evaluation (turn end)

| Variable | Config key | Default | Description |
|---|---|---|---|
| `GATE_TRIGGER` | `trigger` | `always` | `always` \| `interval` \| `patterns` |
| `GATE_INTERVAL` | `interval` | `10` | Turns between evaluations (`interval` mode) |
| `GATE_WINDOW` | `window` | `20` | Recent messages examined per evaluation |
| `GATE_PATTERNS_PATH` | `patternsPath` | file in repo | Alternative trigger regexes (`patterns` mode) |
| `GATE_QUESTIONS_PATH` | `questionsPath` | file in repo | Alternative evaluation questionnaire |

### Vetoes and selection thresholds

| Variable | Config key | Default | Description |
|---|---|---|---|
| `GATE_SECRET_THRESHOLD` | `secretThreshold` | `0.5` | Veto: minimum secret probability to discard without proposing |
| `GATE_SESSION_THRESHOLD` | `sessionThreshold` | `0.8` | Veto: minimum probability of being a temporary instruction |
| `GATE_DURABLE_THRESHOLD` | `durableThreshold` | `0.5` | `is_durable` threshold (valid only if `importance` ≥ `importanceMin`) |
| `GATE_FAILURE_THRESHOLD` | `failureThreshold` | `0.5` | `is_failure` threshold: above it, a lesson enters the queue on its own |
| `GATE_IMPORTANCE_THRESHOLD` | `importanceThreshold` | `2.5` | `importance` threshold: above it, the candidate passes on its own |
| `GATE_IMPORTANCE_MIN` | `importanceMin` | `1.5` | Minimum importance required on the conjunctive path with `durableThreshold` |
| `GATE_MAX_QUEUE` | `maxQueue` | `20` | Candidate queue cap (oldest entries fall off) |

### Approval and saving

| Variable | Config key | Default | Description |
|---|---|---|---|
| `GATE_REVIEW_MODE` | `reviewMode` | `confirm` | `confirm` \| `auto` \| `off` |
| `GATE_SYNTHESIZE` | `synthesize` | `true` | `false` = save raw text without LLM synthesis |
| `GATE_SYNTH_PROMPT_PATH` | `synthPromptPath` | (internal default) | Alternative synthesis prompt (placeholders `{target}`, `{state}`) |

### Consolidation

| Variable | Config key | Default | Description |
|---|---|---|---|
| `GATE_RELEVANT_THRESHOLD` | `relevantThreshold` | `0.5` | Below this relevance probability, the entry is dropped |
| `GATE_SAME_FACT_THRESHOLD` | `sameFactThreshold` | `0.55` | Pairs below this "same fact" probability are ignored |
| `GATE_HARD_DROP_THRESHOLD` | `hardDropThreshold` | `0.7` | Hard drop of a duplicate without an available LLM merge: requires this certainty |
| `GATE_PAIR_JACCARD_MIN` | `pairJaccardMin` | `0.3` | Minimum similarity (Jaccard or containment) for two entries to be compared |
| `GATE_CONSOLIDATE_QUESTIONS_PATH` | `consolidateQuestionsPath` | file in repo | Alternative consolidation questionnaire |
| `GATE_PAIR_QUESTIONS_PATH` | `pairQuestionsPath` | file in repo | Alternative pair questionnaire |

### Calibration and logging

| Variable | Config key | Default | Description |
|---|---|---|---|
| `GATE_CALIB_THRESHOLD` | `calibThreshold` | `200` | Logged rows before the "ready to refit" notification |
| `GATE_TUI_LOG` | `tuiLog` | `notify` | `notify` \| `widget` \| `off` — how logs are shown in the TUI |

Equivalence example:

```bash
# env var (temporary override)
GATE_REVIEW_MODE=auto pi --extension ~/pi-flow-memory-gate

# same thing, in the JSON config (permanent)
{ "reviewMode": "auto" }  #  in ~/.pi/agent/memory-gate-config.json
```

## Configuration files

All the gate's "linguistic" behavior lives in editable JSON/TXT files, no recompilation needed:

| File | What it configures |
|---|---|
| `gate-questions.json` | The evaluation questionnaire (required; types: `noul`, `choice`, `score`) |
| `consolidate-questions.json` | Relevance question for consolidation |
| `consolidate-pair-questions.json` | Pair questions (same_fact) |
| `trigger-patterns.json` | Strong/weak/negative trigger regexes for `trigger: "patterns"` |
| `gate-synth-prompt.txt` | Synthesis prompt (opt-in via config; the default lives in code) |

How questions are worded is where gate quality is won or lost: changing them requires no code, just a Pi restart.

## Project structure

```
src/
├── index.ts               entry point: events, commands, wiring
├── config.ts              default < JSON < env layering, validation
├── review.ts              message collection, state building, evaluation
├── log.ts                 TUI logging (notify/widget/off) + file
├── decision/
│   ├── types.ts           question type enum, interfaces
│   ├── answers.ts         answer types
│   ├── questions.ts       questionnaire loading/validation
│   └── client.ts          HTTP: health, decide (compat), decideNative (logits)
├── gate/
│   ├── trigger.ts         trigger modes
│   ├── patterns.ts        trigger regexes
│   ├── filter.ts          vetoes and selection thresholds
│   ├── queue.ts           candidate queue with dedup
│   ├── review-ui.ts       confirm/auto/off + outcome logging
│   └── calib-log.ts       decision logging for calibration
└── memory/
    ├── synthesize.ts      synthesis + multi-entry split (parses `[cat] text`)
    ├── sink.ts            jsonl + Markdown storage
    └── consolidate.ts     drop/dedup/merge with the decision model
```

## Calibration

The decision model's probabilities must be **calibrated on your own domain** (temperature scaling per question type): uncalibrated they are overconfident; calibrated, a 0.7 threshold truly means "70% chance of being right".

The flow supported by this extension:

1. **Bootstrap**: label historical data (e.g. existing memories = positive, never-saved messages = negative), collect logits, fit with `rizzo calibrate`, validate on held-out data, start the server with `--calibration fit.json`
2. **Live**: the extension's `calibration.jsonl` grows automatically with usage (~1 row per judged turn); in `confirm` mode the labels are your own decisions
3. **Periodic refit**: every ~200 rows (or when drift shows), reconvert → 70/30 split → `rizzo calibrate` → validate → restart the server with the new fit

Note: calibration improves the **honesty** of scores, not the accuracy of choices — thresholds remain where the false-positive/false-negative trade-off is decided.

## Testing

```bash
npm run check     # tsc --noEmit + eslint
npm run lint      # eslint only
npm run format    # prettier
```

For a headless end-to-end test you can drive a session with the Pi SDK (`createAgentSession` + the extension factory via jiti), verifying the files produced in `memoryDir`.

## Known limitations

- Judgment is per **whole state**: a message half noise and half valuable is judged as a whole (LLM synthesis mitigates this, dropping the non-durable part at rewrite time)
- Category choice by the decision model is the weakest point (limited accuracy on the 5-way); it improves a lot with per-fact splitting during synthesis
- Default thresholds are tuned for **calibrated** probabilities (which compress toward middle values): with an uncalibrated decision model, adjust them after observation
- The confirmation UI is sequential (one dialog per candidate), not a multi-checkbox: Pi's native API has no multiselect

## License

MIT
