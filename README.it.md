# pi-flow-memory-gate

Estensione per [Pi](https://pi.dev) che gestisce la memoria dell'agente con un **modello decisionale locale**: un modello linguistico di piccole dimensioni, in esecuzione sul tuo computer, decide a ogni turno cosa merita di essere ricordato — **senza spendere un singolo token del modello principale**.

Pensata per lavorare insieme a `pi-hermes-memory` (che resta attivo per ricerca, indicizzazione sessioni e secret scanning), ma ne sostituisce il ciclo di auto-memoria: al posto dell'LLM principale che rivede la conversazione ogni N turni, qui è un modello decisionale da ~0.3 secondi per giudizio a fare la selezione, e tu approvi.

```
fine turno → decision model giudica (0 token LLM)
           → veto: mai proporre segreti o istruzioni temporanee
           → candidati → conferma tua (o auto) 
           → sintesi LLM: riscrittura pulita, split in memorie multiple
           → salvataggio in file locali (jsonl + Markdown)
           → consolidazione periodica: decision model scarta doppioni e obsoleti
           → ogni decisione viene loggata → dati per la calibrazione
```

## Perché

Il collo di bottiglia dell'auto-memoria classica è la **selezione**: un LLM grande che legge decine di messaggi per decidere cosa salvare. Questo progetto sposta la selezione su un modello decisionale (nella versione di riferimento [Rizzo Flow](https://github.com/Rizzo-AI-Academy/rizzo-flow), 4B, compatibile con l'interfaccia `/v1/systemone`) che gira in locale e risponde in poche centinaia di millisecondi con probabilità tipizzate — zero testo generato, zero parsing, zero allucinazioni di formato. Il modello principale viene coinvolto solo per gli ultimi due passi, e solo su ciò che è già stato approvato:

| Fase | Chi | Costo |
|---|---|---|
| Giudizio (durable? segreto? categoria?) | decision model | ~0.3s, 0 token |
| Veto (segreti, istruzioni di sessione) | decision model | 0 token |
| Approvazione | tu (o soglie in auto) | 30s ogni tanto |
| Sintesi + split in memorie | LLM, solo sugli approvati | pochi token |
| Consolidazione (drop/dedup) | decision model | 0 token |
| Merge veri (rari) | LLM | pochi token |

## Indice

- [Installazione](#installazione)
- [Configurazione](#configurazione)
- [Configurazione del decision model](#configurazione-del-decision-model)
- [Funzionalità](#funzionalità)
- [Comandi](#comandi)
- [Variabili d'ambiente](#variabili-dambiente)
- [File di configurazione](#file-di-configurazione)
- [Struttura del progetto](#struttura-del-progetto)
- [Calibrazione](#calibrazione)
- [Test](#test)
- [Limiti noti](#limiti-noti)
- [Licenza](#licenza)

## Installazione

Requisiti: Pi con supporto estensioni, un decision model raggiungibile via HTTP (vedi sotto), Node/npm per lo sviluppo.

```bash
git clone https://github.com/tuoutente/pi-flow-memory-gate
cd pi-flow-memory-gate
npm install

# sviluppo: carica l'estensione direttamente
pi --extension ~/pi-flow-memory-gate

# oppure copiala nella directory estensioni di Pi
```

## Configurazione

La configurazione vive in un file JSON: `~/.pi/agent/memory-gate-config.json` (crealo se non esiste; senza file valgono i default). Ogni chiave è opzionale:

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

I tre livelli, in ordine di priorità crescente:

1. **default** hardcoded nel codice
2. **`memory-gate-config.json`** — la configurazione stabile del tuo setup
3. **variabili d'ambiente** — override temporanei, ideali per test e prove (tabella completa sotto)

Valori invalidi nel JSON vengono ignorati con un warning: un typo non rompe mai il gate.

## Configurazione del decision model

L'estensione è generica: punta a qualunque server che esponga `/health`, `/v1/systemone` (formato compatibile) e `/v1/decisions` (endpoint nativo, per i logits). Il riferimento di sviluppo è Rizzo Flow:

```bash
git clone https://github.com/Rizzo-AI-Academy/rizzo-flow && cd rizzo-flow
uv sync --locked --extra mlx        # su Apple Silicon; su altri hardware vedi il loro README
uv run rizzo download --backend mlx
uv run rizzo serve --backend mlx --bits 8 --calibration fit.json
```

Poi:

```bash
export DECISION_MODEL_URL=http://127.0.0.1:8017
```

Se il decision model è spento, il gate si mette in silenzio (una riga di log) e non fa nulla: Pi continua a funzionare normalmente.

## Funzionalità

### 1. Valutazione a fine turno

A ogni `turn_end` l'estensione raccoglie i messaggi utente/assistente recenti, costruisce uno *state* per ogni messaggio utente (con la risposta assistente che segue) e lo sottopone al decision model con il questionario configurabile. Ogni messaggio viene giudicato **una sola volta** (cursore sulla posizione di sessione), quindi i retry di turno non producono giudizi duplicati.

Tre modalità di trigger (config `trigger`):

- `always` (default) — valuta ogni turno: la copertura massima, il costo è ~0.3s a fine turno
- `interval` — valuta ogni `interval` turni (stile background review classico)
- `patterns` — valuta solo se l'ultimo messaggio utente matcha una regex configurabile (config `patternsPath`, file `trigger-patterns.json`, struttura strong/weak/negative ispirata ai correction detector di pi-hermes-memory, con pattern italiani inclusi); se il file manca, degrada ad `always`

### 2. Veto hard

Due categorie non vengono mai proposte, decise dal decision model prima ancora di entrare in coda:

- **segreti**: password, API key, token (`has_secret` ≥ `secretThreshold`). Nota: un *puntatore* a un segreto ("la password sta in .env") non è il segreto stesso — non viene vetoato
- **istruzioni di sessione**: preferenze esplicitamente temporanee ("per questa sessione usa il modello grande", `is_session_scoped` ≥ `sessionThreshold`)

### 3. Selezione candidati

Superati i veto, uno state entra in coda se `target ≠ none` e almeno una di:

- `is_failure` ≥ `failureThreshold` (le lezioni apprese passano da sole)
- `importance` ≥ `importanceThreshold`
- `is_durable` ≥ `durableThreshold` **e** `importance` ≥ `importanceMin` (congiunto: un solo segnale debole non basta)

La coda ha deduplicazione (identica o simile al 80%+ su prima riga e token) e un tetto (`maxQueue`).

### 4. Approvazione: confirm, auto o off

`reviewMode` (config) / `GATE_REVIEW_MODE` (env):

- `confirm` (default) — comando `/memory-review`: per ogni candidato un dialog sì/no con categoria, punteggi e preview. Ogni tua scelta è un'etichetta di calibrazione
- `auto` — tutto ciò che supera veto e soglie viene salvato senza chiedere (full auto-memory)
- `off` — il gate osserva e logga, non salva nulla

### 5. Sintesi e split in memorie multiple

Ogni candidato approvato passa a un LLM (il **modello corrente della chat**, catturato automaticamente e aggiornato se cambi modello mid-sessione) che:

- lo riscritte in 1-2 frasi dense, nello stile di una banca memorie (dettagli concreti sì, saluti e cornice no, stessa lingua dell'estratto)
- **estrae i fatti distinti**: un messaggio che contiene due memorie diverse diventa due voci separate, ciascuna con la propria categoria (es. `[failure]` per una lezione, `[memory]` per un fatto d'ambiente) — e la categorizzazione per fatto singolo risulta più precisa di quella per messaggio intero
- il prompt è configurabile (`gate-synth-prompt.txt` via `synthPromptPath`, segnaposto `{target}` e `{state}`)

Se il modello non è raggiungibile, fallback: si salva la prima riga grezza (meglio grezzo che perso).

### 6. Salvataggio standalone

Le memorie approvate finiscono in `~/.pi/agent/memory-gate/` (configurabile con `memoryDir`):

- `memories.jsonl` — record completo: contenuto sintetizzato, categoria, timestamp, punteggi grezzi del decision model, state originale
- `MEMORY.md` — export leggibile: una riga `- [categoria] memoria` per voce

### 7. Consolidazione

Comando `/memory-consolidate`. Tre fasi, quasi tutte a costo zero:

1. per ogni entry: `still_relevant` sul decision model — sotto soglia, droppata (0 token)
2. per ogni coppia sospetta (similarità Jaccard + containment sui token): `same_fact` sul decision model — se è lo stesso fatto, si tiene la sintetizzata (o la più recente) e si droppa l'altra (0 token)
3. solo i merge genuini (fatti simili ma complementari) vanno all'LLM, che fonde preservando tutti i dettagli (pochi token)

Cautela incorporata: senza LLM disponibile il drop secco richiede una certezza alta (`hardDropThreshold`, default 0.7); i casi borderline vengono lasciati per il giro successivo. Prima di riscrivere i file viene creato un backup `.bak`.

### 8. Logging di calibrazione

Ogni decisione del gate (approvata, scartata, filtrata, vetoata) viene loggata in `~/.pi/agent/memory-gate/calibration.jsonl` con i **logits grezzi** del decision model (via endpoint nativo `/v1/decisions`), i punteggi, l'esito e lo state. Il file è il dataset per rifittare le temperature del decision model — vedi [Calibrazione](#calibrazione). Il contatore è visibile in `/gate-status` (`87/200 rows`); al raggiungimento della soglia (`calibThreshold`) arriva una notifica una tantum per sessione.

### 9. Log in TUI

Tutti i messaggi del gate vengono renderizzati da Pi, mai scritti grezzi sul terminale (config `tuiLog`):

- `notify` (default) — popup transiente per ogni evento
- `widget` — pannello persistente sopra l'editor con le ultime 8 righe di eventi
- `off` — solo file

In ogni caso tutto finisce anche su `~/.pi/agent/memory-gate/gate.log` (con timestamp e livello), e in modalità headless (`pi -p`, SDK) l'output va su console.

## Comandi

| Comando | Cosa fa |
|---|---|
| `/gate-status` | Stato: connessione al decision model, modalità attive, righe di calibrazione |
| `/memory-review` | Rivede i candidati in coda: dialog di conferma per ognuno (modalità `confirm`) |
| `/gate-review` | Forza una valutazione subito, ignorando la modalità di trigger |
| `/memory-consolidate` | Compatta le memorie salvate (drop irrilevanti e doppioni, merge) |

## Variabili d'ambiente (override)

Le variabili d'ambiente soprascrivono il file di configurazione JSON: sono pensate per test, prove rapide e override temporanei, non come configurazione stabile (per quello usa `memory-gate-config.json`). Ogni variabile corrisponde a una chiave del config JSON, indicata nella seconda colonna. Le variabili non riconosciute o con valore invalido vengono ignorate.

### Connessione e comportamento generale

| Variabile | Chiave config | Default | Descrizione |
|---|---|---|---|
| `DECISION_MODEL_URL` | `decisionModelUrl` | `http://127.0.0.1:8017` | Endpoint del decision model |
| `DECISION_MODEL_ID` | `decisionModelId` | `rizzo-latest` | Model id passato all'API |
| `GATE_MEMORY_DIR` | `memoryDir` | `~/.pi/agent/memory-gate` | Directory dei dati (memorie, log, calibrazione) |
| `GATE_DEBUG` | `debug` | `false` | `1` = log di debug (punteggi completi) su file |

### Valutazione (fine turno)

| Variabile | Chiave config | Default | Descrizione |
|---|---|---|---|
| `GATE_TRIGGER` | `trigger` | `always` | `always` \| `interval` \| `patterns` |
| `GATE_INTERVAL` | `interval` | `10` | Turni tra le valutazioni (modalità `interval`) |
| `GATE_WINDOW` | `window` | `20` | Messaggi recenti esaminati a ogni valutazione |
| `GATE_PATTERNS_PATH` | `patternsPath` | file nel repo | Regex trigger alternative (modalità `patterns`) |
| `GATE_QUESTIONS_PATH` | `questionsPath` | file nel repo | Questionario di valutazione alternativo |

### Veto e soglie di selezione

| Variabile | Chiave config | Default | Descrizione |
|---|---|---|---|
| `GATE_SECRET_THRESHOLD` | `secretThreshold` | `0.5` | Veto: probabilità minima di contenere segreti per scartare senza proporre |
| `GATE_SESSION_THRESHOLD` | `sessionThreshold` | `0.8` | Veto: probabilità minima di essere istruzione temporanea |
| `GATE_DURABLE_THRESHOLD` | `durableThreshold` | `0.5` | Soglia `is_durable` (valida solo se `importance` ≥ `importanceMin`) |
| `GATE_FAILURE_THRESHOLD` | `failureThreshold` | `0.5` | Soglia `is_failure`: sopra, la lezione entra in coda da sola |
| `GATE_IMPORTANCE_THRESHOLD` | `importanceThreshold` | `2.5` | Soglia `importance`: sopra, il candidato passa da solo |
| `GATE_IMPORTANCE_MIN` | `importanceMin` | `1.5` | Importance minima richiesta nel percorso congiunto con `durableThreshold` |
| `GATE_MAX_QUEUE` | `maxQueue` | `20` | Tetto della coda candidati (le voci più vecchie cadono) |

### Approvazione e salvataggio

| Variabile | Chiave config | Default | Descrizione |
|---|---|---|---|
| `GATE_REVIEW_MODE` | `reviewMode` | `confirm` | `confirm` \| `auto` \| `off` |
| `GATE_SYNTHESIZE` | `synthesize` | `true` | `false` = salva il testo grezzo senza sintesi LLM |
| `GATE_SYNTH_PROMPT_PATH` | `synthPromptPath` | (default interno) | Prompt di sintesi alternativo (segnaposto `{target}`, `{state}`) |

### Consolidazione

| Variabile | Chiave config | Default | Descrizione |
|---|---|---|---|
| `GATE_RELEVANT_THRESHOLD` | `relevantThreshold` | `0.5` | Sotto questa probabilità di rilevanza, l'entry viene droppata |
| `GATE_SAME_FACT_THRESHOLD` | `sameFactThreshold` | `0.55` | Coppie sotto questa probabilità di \"stesso fatto\" vengono ignorate |
| `GATE_HARD_DROP_THRESHOLD` | `hardDropThreshold` | `0.7` | Drop secco di un doppione senza merge LLM disponibile: richiede questa certezza |
| `GATE_PAIR_JACCARD_MIN` | `pairJaccardMin` | `0.3` | Similarità minima (Jaccard o containment) perché due entry vengano confrontate |
| `GATE_CONSOLIDATE_QUESTIONS_PATH` | `consolidateQuestionsPath` | file nel repo | Questionario di consolidamento alternativo |
| `GATE_PAIR_QUESTIONS_PATH` | `pairQuestionsPath` | file nel repo | Questionario per le coppie alternativo |

### Calibrazione e log

| Variabile | Chiave config | Default | Descrizione |
|---|---|---|---|
| `GATE_CALIB_THRESHOLD` | `calibThreshold` | `200` | Righe loggate prima della notifica \"pronto per rifittare\" |
| `GATE_TUI_LOG` | `tuiLog` | `notify` | `widget` \| `notify` \| `off` — come vengono mostrati i log nella TUI |

Esempio di equivalenza:

```bash
# env var (override temporaneo)
GATE_REVIEW_MODE=auto pi --extension ~/pi-flow-memory-gate

# stessa cosa, nel config JSON (permanente)
{ "reviewMode": "auto" }  #  in ~/.pi/agent/memory-gate-config.json
```

## File di configurazione

Tutto il comportamento "linguistico" del gate vive in file JSON/TXT modificabili senza ricompilare:

| File | Cosa configura |
|---|---|
| `gate-questions.json` | Il questionario della valutazione (obbligatorio; tipi: `noul`, `choice`, `score`) |
| `consolidate-questions.json` | Domanda di rilevanza per la consolidazione |
| `consolidate-pair-questions.json` | Domande per le coppie (same_fact) |
| `trigger-patterns.json` | Regex strong/weak/negative per `trigger: "patterns"` |
| `gate-synth-prompt.txt` | Prompt della sintesi (opt-in via env; il default è nel codice) |

Le formulazioni delle domande sono il posto dove si gioca la qualità del gate: cambiarle non richiede codice, solo un riavvio di Pi.

## Struttura del progetto

```
src/
├── index.ts               entry point: eventi, comandi, wiring
├── config.ts              layering default < JSON < env, validazione
├── review.ts              raccolta messaggi, costruzione states, valutazione
├── log.ts                 log TUI (widget/notify/off) + file
├── decision/
│   ├── types.ts           enum tipi domanda, interfacce
│   ├── answers.ts         tipi delle risposte
│   ├── questions.ts       caricamento/validazione questionario
│   └── client.ts          HTTP: health, decide (compat), decideNative (logits)
├── gate/
│   ├── trigger.ts         modalità di trigger
│   ├── patterns.ts        regex trigger
│   ├── filter.ts          veto e soglie di selezione
│   ├── queue.ts           coda candidati con dedup
│   ├── review-ui.ts       conferma/auto/off + logging esiti
│   └── calib-log.ts       logging decisioni per la calibrazione
└── memory/
    ├── synthesize.ts      sintesi + split multi-entry (parse `[cat] testo`)
    ├── sink.ts            salvataggio jsonl + Markdown
    └── consolidate.ts     drop/dedup/merge con decision model
```

## Calibrazione

Le probabilità del decision model vanno **calibrate sul proprio dominio** (temperature scaling per tipo di domanda): senza calibrazione sono sovraccariche di fiducia, con la calibrazione una soglia 0.7 significa davvero "70% di probabilità che sia giusto".

Il flusso supportato da questa estensione:

1. **Bootstrap**: etichettare dati storici (es. memorie esistenti = positive, messaggi mai salvati = negative), raccogliere i logits, fittare con `rizzo calibrate`, validare su held-out, avviare il server con `--calibration fit.json`
2. **Dal vivo**: il `calibration.jsonl` dell'estensione cresce automaticamente con l'uso (~1 riga per turno giudicato); in modalità `confirm` le etichette sono le tue decisioni
3. **Rifit periodico**: ogni ~200 righe (o quando si nota drift), riconvertire → split 70/30 → `rizzo calibrate` → validare → riavviare il server col nuovo fit

Nota: la calibrazione migliora l'**onestà** dei punteggi, non l'accuratezza delle scelte — le soglie restano il posto dove si decide il compromesso falsi positivi/negativi.

## Test

```bash
npm run check     # tsc --noEmit + eslint
npm run lint      # solo eslint
npm run format    # prettier
```

Per un test end-to-end headless si può pilotare una sessione con l'SDK di Pi (`createAgentSession` + factory dell'estensione via jiti), verificando i file prodotti in `memoryDir`.

## Limiti noti

- Il giudizio è per **state intero**: un messaggio metà rumoroso e metà prezioso viene valutato nel complesso (la sintesi LLM mitiga, scartando la parte non durevole al momento della riscrittura)
- La scelta della categoria da parte del decision model è il punto più debole (accuratezza limitata sul 5-way); migliora molto con lo split per fatto della sintesi
- Le soglie di default sono tarate su probabilità **calibrate** (che tendono a compressione verso valori centrali): con un decision model non calibrato vanno ritoccate al ribasso o al rialzo dopo osservazione
- La UI di conferma è sequenziale (un dialog per candidato), non una checkbox multipla: l'API nativa di Pi non offre multiselect

## Licenza

MIT
