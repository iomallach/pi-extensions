# pi-knowledge-search Plugin Reference

> **Audience:** Developers building a pi extension that implements local vector search + optional Bedrock Knowledge Base retrieval.

---

## 1. Overview

`pi-knowledge-search` is a pi extension that indexes a local file tree as dense vector embeddings and exposes a `knowledge_search` tool to the LLM. On session start it forks a background sync worker to scan configured directories, chunk files, embed chunks, and persist results to a local `index.json`. The main process remains unblocked; it reloads the index after the worker reports completion.

Optionally, the plugin fans out the same query to one or more AWS Bedrock Knowledge Bases and merges the results with local hits before returning them to the model. Either source can be used alone — the plugin disables any subsystem that is not configured.

---

## 2. Architecture

### Two-Process Design

```
┌───────────────────────────────────────────────────────────────┐
│  pi host process                                              │
│                                                               │
│  session_start ──► loadConfig()                               │
│                 ├─► createEmbedder()                          │
│                 ├─► KnowledgeIndex.loadSync()   (read-only)   │
│                 ├─► BedrockKBSearcher()         (optional)    │
│                 └─► fork("dist/sync-worker.mjs")              │
│                                          │                    │
│  knowledge_search tool                   │ stdout JSON stats  │
│  ├─► KnowledgeIndex.search()             │                    │
│  └─► BedrockKBSearcher.search()          │                    │
│       └─► merge + sort ──► LLM           │                    │
└──────────────────────────────────────────┼────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────┐
│  sync-worker child process  (dist/sync-worker.mjs)           │
│                                                              │
│  loadConfig()                                                │
│  createEmbedder()                                            │
│  KnowledgeIndex.loadSync()   ──► read current index.json     │
│  KnowledgeIndex.sync()                                       │
│    ├─► scanAllFiles()                                        │
│    ├─► chunkMarkdown()  ──► Chunk[]                          │
│    ├─► embedder.embedBatch()  ──► vector[]                   │
│    └─► scheduleSave()  ──► index.json                        │
│  stdout: { added, updated, removed, size, chunks }  exit(0) │
└──────────────────────────────────────────────────────────────┘
```

### Component Map

| Component | File | Role |
|---|---|---|
| Extension entry point | `src/index.ts` | Register hooks, tools, commands |
| Central search engine | `src/index-store.ts` | Index CRUD, embed, search |
| Chunker | `src/chunker.ts` | Split markdown into chunks |
| Embedder | `src/embedder.ts` | OpenAI / Bedrock / Ollama |
| Sync worker | `src/sync-worker.ts` | Background file scanning |
| Bedrock KB client | `src/kb-searcher.ts` | AWS Bedrock retrieval |
| Config loader | `src/config.ts` | File + env-var config |

---

## 3. Extension Registration

### `package.json` Fields

```jsonc
{
  "name": "pi-knowledge-search",
  "version": "1.0.1",
  "keywords": ["pi-package", "extension"],   // marks this as a pi plugin
  "pi": {
    "extensions": ["./src/index.ts"]         // entry point pi loads
  },
  "dependencies": {
    "tsx": "^4.21.0"                         // runtime TS execution — no build step
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "optionalDependencies": {
    // AWS SDK packages — only needed for Bedrock provider or KB
    "@aws-sdk/client-bedrock-agent-runtime": "*",
    "@aws-sdk/client-bedrock-runtime": "*"
  },
  "scripts": {
    "build:worker": "esbuild src/sync-worker.ts --bundle --format=esm --platform=node --external:better-sqlite3 --outfile=dist/sync-worker.mjs",
    "test": "node --test --import tsx src/**/*.test.ts"
  }
}
```

> **Note:** Only the sync worker is pre-compiled (`dist/sync-worker.mjs`). The rest of the extension runs via `tsx` at load time — no build step required for the main plugin.

### Entry Point Signature

```typescript
// src/index.ts
export default function (pi: ExtensionAPI): void
```

`pi` is the `ExtensionAPI` object injected by the host. The function registers everything synchronously; async work is deferred to lifecycle hooks.

---

## 4. Lifecycle Hooks

### `session_start`

Fires when a pi session opens. Performs all initialisation.

```
1. loadConfig()                            → null → plugin disables itself
2. createEmbedder(config.provider, config.dimensions)
3. new KnowledgeIndex(config, embedder).loadSync()
4. new BedrockKBSearcher(config.knowledgeBases)   [if any KBs configured]
5. KB-only mode (no provider)?  → syncDone = true, return
6. fork("dist/sync-worker.mjs")
   Worker exit:
     exit 0 → index.loadSync() + ui.setStatus() for 5 s
     exit 1 → restart (max 3 times within 60 s window)
   worker.unref() so it won't block process exit
```

**Module-level state managed by this hook:**

```typescript
let index: KnowledgeIndex | null = null;
let kbSearcher: BedrockKBSearcher | null = null;
let currentConfig: Config | null = null;
let syncDone = false;           // true after worker reports success
let workerExitExpected = false; // set before intentional shutdown
```

### `session_shutdown`

```typescript
pi.on("session_shutdown", async () => {
  workerExitExpected = true;
  index?.close(); // flushes any pending debounced save
});
```

> **Note:** A file watcher was intentionally removed (commit `d38a81f`) because it caused UI freezes. The plugin syncs once on startup only.

---

## 5. Registered Tools and Commands

### Tool: `knowledge_search`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | `string` | *(required)* | Natural-language search query |
| `limit` | `number` | `8` | Max results; clamped to 20 |

**Execute flow:**

```
1. Guard: index or kbSearcher must be ready; otherwise return error string
2. limit = Math.min(params.limit ?? 8, 20)
3. Parallel: index.search(query, limit, signal)
           + kbSearcher.search(query, limit, signal)
4. Merge arrays, sort by score DESC, take top limit
5. Format each result:
     ### N. ~/path/to/file > Heading (XX.X% match)
     
     excerpt text
6. Return { content: [{ type: "text", text }], details: { resultCount, indexSize } }
```

---

### Command: `/knowledge-search-setup`

Interactive setup wizard. Steps:

1. Which directories to index?
2. Which file extensions?
3. Which directories to exclude?
4. Which embedding provider? (`openai` / `bedrock` / `ollama`)
5. Provider-specific prompts (API key, model, URL, etc.)
6. `saveConfig()` → writes `~/.pi/knowledge-search.json`
7. Prompts user to run `/reload`

### Command: `/knowledge-add-kb`

Adds a Bedrock Knowledge Base ID to the config array. Reads current config, appends the new KB entry, deduplicates by KB ID, saves.

### Command: `/knowledge-reindex`

Forces a full rebuild of the local index:

```typescript
await index.rebuild(); // clears all entries, then calls sync()
```

Reports total file and chunk counts on completion.

---

## 6. Configuration

### File Location

```
process.env.KNOWLEDGE_SEARCH_CONFIG ?? ~/.pi/knowledge-search.json
```

Returns `null` if the file is absent and no env-var override provides enough to proceed. A `null` config disables the plugin cleanly (no error, no hooks active).

### All Fields and Env Vars

| Config field | Env var override | Default | Notes |
|---|---|---|---|
| Config file path | `KNOWLEDGE_SEARCH_CONFIG` | `~/.pi/knowledge-search.json` | Path only |
| `dirs` | `KNOWLEDGE_SEARCH_DIRS` | *(from file)* | Comma-separated paths |
| `fileExtensions` | `KNOWLEDGE_SEARCH_EXTENSIONS` | `.md,.txt` | Comma-separated |
| `excludeDirs` | `KNOWLEDGE_SEARCH_EXCLUDE` | `node_modules,.git,.obsidian,.trash` | Comma-separated |
| `dimensions` | `KNOWLEDGE_SEARCH_DIMENSIONS` | `512` | Must match stored index |
| `indexDir` | `KNOWLEDGE_SEARCH_INDEX_DIR` | `~/.pi/knowledge-search` | Directory, not file |
| `provider.type` | `KNOWLEDGE_SEARCH_PROVIDER` | *(from file)* | `openai\|bedrock\|ollama` |
| OpenAI API key | `KNOWLEDGE_SEARCH_OPENAI_API_KEY` or `OPENAI_API_KEY` | *(required for openai)* | Falls back to standard var |
| OpenAI model | `KNOWLEDGE_SEARCH_OPENAI_MODEL` | `text-embedding-3-small` | |
| Bedrock AWS profile | `KNOWLEDGE_SEARCH_BEDROCK_PROFILE` | `default` | |
| Bedrock AWS region | `KNOWLEDGE_SEARCH_BEDROCK_REGION` | `us-east-1` | |
| Bedrock model | `KNOWLEDGE_SEARCH_BEDROCK_MODEL` | `amazon.titan-embed-text-v2:0` | |
| Ollama URL | `KNOWLEDGE_SEARCH_OLLAMA_URL` | `http://localhost:11434` | |
| Ollama model | `KNOWLEDGE_SEARCH_OLLAMA_MODEL` | `nomic-embed-text` | |

### Loading Logic

1. Read JSON file from path above.
2. For each field: env var wins if set; otherwise use file value; otherwise use default.
3. `~` in path values is expanded to `$HOME`.
4. `knowledgeBases` array is only stored in the JSON file (no env-var equivalent).

### KB-Only Mode

If `dirs` / `provider` are absent but `knowledgeBases` is populated, the plugin operates in KB-only mode: no local index is built, `syncDone = true` immediately.

---

## 7. Storage Layer

### Index File

```
{config.indexDir}/index.json   (default: ~/.pi/knowledge-search/index.json)
```

### Schema

```typescript
interface IndexData {
  version: number;     // Must equal INDEX_VERSION (3)
  dimensions: number;  // Must equal config.dimensions
  entries: Record<string, IndexEntry>;  // key: "absPath#chunkIndex"
}

interface IndexEntry {
  relPath: string;    // Path relative to the source directory root
  sourceDir: string;  // Which root dir this entry belongs to
  mtime: number;      // File mtime in ms at index time
  vector: number[];   // Pre-normalised embedding (length = dimensions)
  excerpt: string;    // Raw chunk text, capped at MAX_EXCERPT_LENGTH (3500) chars
  heading: string;    // Section heading, or "intro" for pre-heading content
  chunkIndex: number; // 0-based chunk position within the file
}
```

### Version Gate

On load, if `data.version !== INDEX_VERSION` **or** `data.dimensions !== config.dimensions`, the stored index is discarded and a full re-index is triggered.

### Save Debounce

Writes are batched: `scheduleSave()` sets a 5-second timer. If another write arrives within the window, the timer resets. `close()` (called from `session_shutdown`) bypasses the timer and flushes immediately.

---

## 8. Chunking Pipeline

File: `src/chunker.ts`

**Short-circuit:** Files ≤ 3000 chars are returned as a single chunk.

### Stage 1 — Heading Split

Split on headings `##` through `######` (H2–H6). H1 is **not** a split point. Content before the first heading is assigned the sentinel heading `"intro"`.

```typescript
const HEADING_RE = /^#{2,6} .+/m;
```

### Stage 2 — Paragraph Split

Each heading section is further split on double newlines (`\n\n`) to produce paragraph-level chunks.

### Stage 3 — Hard Split (overlap)

Any chunk still exceeding `maxChunkSize` (3000 chars) is split at the character boundary with a 200-char overlap to preserve sentence context across boundaries.

### Stage 4 — Merge Tiny

Adjacent chunks smaller than `minChunkSize` (200 chars) are merged together to avoid embedding near-empty passages.

### Parameters

| Constant | Value | Purpose |
|---|---|---|
| `maxChunkSize` | 3000 chars | Hard split threshold |
| `minChunkSize` | 200 chars | Merge threshold |
| Overlap | 200 chars | Preserved text at hard-split boundaries |

---

## 9. Embedding Providers

### Interface

```typescript
interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(texts: string[], signal?: AbortSignal, concurrency?: number): Promise<(number[] | null)[]>;
}
```

### Factory

```typescript
export function createEmbedder(config: ProviderConfig, dimensions: number): Embedder
// dispatches on config.type: "openai" | "bedrock" | "ollama"
```

### Shared Helpers

**`truncate(text, maxChars = 10_000)`**
Caps input at 10,000 characters before embedding (≈ 4–6K tokens for typical prose).

**`withRateLimitRetry<T>(fn, label)`**
Wraps any async call with exponential back-off on HTTP 429 or `ThrottlingException`:

```typescript
const RETRY_DELAYS = [1000, 2000, 4000]; // ms — 3 attempts maximum
```

**`parallelMap<T, R>(items, fn, concurrency, signal?)`**
Bounded-concurrency async map. Uses a shared cursor so workers pull the next item when ready. Throws immediately if `signal.aborted`.

---

### OpenAI Embedder

| Property | Value |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/embeddings` |
| Native batch size | 100 texts per request |
| Request body | `{ input: string[], model, dimensions }` |
| Default model | `text-embedding-3-small` |
| Response handling | Positions via `item.index` (handles sparse responses) |

### Bedrock Embedder

| Property | Value |
|---|---|
| AWS API | `InvokeModelCommand` on `BedrockRuntimeClient` |
| Request body | `{ inputText, dimensions, normalize: true }` |
| Default model | `amazon.titan-embed-text-v2:0` |
| Concurrency | 10 parallel calls via `parallelMap` |
| Client init | Lazy — `clientPromise` resolved on first use |

### Ollama Embedder

| Property | Value |
|---|---|
| Endpoint | `POST ${url}/api/embed` |
| Request body | `{ model, input: string }` (single text per call) |
| Response | `{ embeddings: number[][] }` → `[0]` |
| Default model | `nomic-embed-text` |
| Default URL | `http://localhost:11434` |
| Concurrency | 4 parallel calls via `parallelMap` |

---

## 10. Sync Worker

### Forking Pattern

```typescript
// src/index.ts — session_start
import { fork } from "node:child_process";

const worker = fork("dist/sync-worker.mjs", [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"]
});
worker.unref(); // does not block process exit
```

The worker is pre-compiled (`npm run build:worker` → esbuild → ESM bundle) to avoid ESM/CJS resolution cycles when `tsx` is the runtime on Node 25+.

### Communication Protocol

| Channel | Content |
|---|---|
| **stdout** | Single JSON line on success: `{ added, updated, removed, size, chunks }` |
| **stderr** | Error messages (forwarded to pi logs) |
| **exit 0** | Success; parent calls `index.loadSync()` to pick up changes |
| **exit 1** | Failure; parent may restart |

### Restart Logic

```
Constants:
  MAX_WORKER_RESTARTS = 3
  RESTART_WINDOW_MS   = 60_000   (1 minute)

On exit != 0 and !workerExitExpected:
  if restartCount < MAX_WORKER_RESTARTS within RESTART_WINDOW_MS:
    fork() again
  else:
    log warning, give up
```

### Worker Process Flow

```
1. Register uncaughtException + unhandledRejection -> stderr + exit(1)
2. loadConfig() -> null? exit(0)
3. createEmbedder(config.provider, config.dimensions)
4. new KnowledgeIndex(config, embedder)
5. index.loadSync()          // read current state
6. await index.sync()        // scan, chunk, embed, persist
7. process.stdout.write(JSON.stringify({ added, updated, removed, size, chunks }) + "\n")
8. process.exit(0)
```

---

## 11. Search Pipeline

```
knowledge_search(query, limit)
  │
  ├─ embedder.embed(query) -> queryVector   [truncated to 10k chars]
  │
  ├─ For each IndexEntry:
  │    score = dotProduct(queryVector, entry.vector)   // cosine sim (pre-normalised)
  │
  ├─ Sort entries by score DESC
  │
  ├─ Deduplicate: keep only the highest-scoring chunk per absolute file path
  │
  ├─ Filter: score > 0.15
  │
  └─ Take top `limit` -> SearchResult[]
```

```typescript
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}
```

### Embed Text Format (indexing)

```typescript
`Title: ${relPath without extension, "/" => " > "}${sectionContext}\n\n${chunkText}`
```

Example: `"Title: docs/api > Authentication\n\nThe API uses bearer tokens…"`

Prepending a human-readable path + heading to each chunk significantly improves retrieval relevance.

---

## 12. Bedrock KB Integration

### Lazy Initialisation

The AWS SDK is imported dynamically on the **first** `search()` call:

```typescript
const { BedrockAgentRuntimeClient, RetrieveCommand } = await import(
  "@aws-sdk/client-bedrock-agent-runtime"
);
```

This means users who only use OpenAI/Ollama never pay the SDK load cost and don't need the optional AWS packages installed.

### Client Caching

Multiple KBs sharing the same `region:profile` pair reuse one `BedrockAgentRuntimeClient` instance (keyed by `"region:profile"`).

### Multi-KB Fan-Out

```typescript
// One RetrieveCommand per KB, all in parallel
const results = await Promise.all(
  this.configs.map(cfg => this.queryKB(cfg, query, limit))
);
```

### RetrieveCommand Parameters

```typescript
{
  knowledgeBaseId: cfg.id,
  retrievalQuery: { text: query },
  retrievalConfiguration: {
    vectorSearchConfiguration: { numberOfResults: limit }
  }
}
```

### Result Normalisation

1. Discard results with `score < 0.15`
2. Extract URI from location type: `S3 | WEB | CONFLUENCE | SALESFORCE | SHAREPOINT | "unknown"`
3. Append label suffix: `[KB]` (default) or `[${config.label}]`
4. Flatten all KB results, sort by score DESC, take top `limit`
5. Return as `SearchResult[]` — same shape as local index results

### `KnowledgeBaseConfig`

```typescript
interface KnowledgeBaseConfig {
  id: string;       // Bedrock Knowledge Base ID
  region?: string;  // default: "us-east-1"
  profile?: string; // default: "default"
  label?: string;   // display label appended to result path
}
```

---

## 13. Key Constants Reference

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `INDEX_VERSION` | `3` | `index-store.ts` | Schema version; mismatch triggers full re-index |
| `MAX_EXCERPT_LENGTH` | `3500` chars | `index-store.ts` | Safety cap on stored excerpt text |
| `BATCH_SIZE` | `50` | `index-store.ts` | Chunks per `embedBatch()` call during sync |
| `SCORE_THRESHOLD` | `0.15` | `index-store.ts`, `kb-searcher.ts` | Minimum score for any result |
| `SAVE_DEBOUNCE_MS` | `5000` ms | `index-store.ts` | Delay before writing `index.json` |
| `DEFAULT_LIMIT` | `8` | `index.ts` | Default `knowledge_search` result count |
| `MAX_RESULT_LIMIT` | `20` | `index.ts` | Hard cap on `knowledge_search` limit |
| `MAX_WORKER_RESTARTS` | `3` | `index.ts` | Max sync worker restart attempts |
| `RESTART_WINDOW_MS` | `60_000` ms | `index.ts` | Window for counting restart attempts |
| `TRUNCATE_MAX_CHARS` | `10_000` | `embedder.ts` | Max chars sent to any embedding API |
| `RETRY_DELAYS` | `[1000, 2000, 4000]` ms | `embedder.ts` | Back-off schedule for rate-limit retries |
| `OPENAI_BATCH` | `100` | `embedder.ts` | OpenAI texts per batch request |
| `DEFAULT_DIMENSIONS` | `512` | `config.ts` | Default embedding dimensions |
| `maxChunkSize` | `3000` chars | `chunker.ts` | Chunk hard-split threshold |
| `minChunkSize` | `200` chars | `chunker.ts` | Chunk merge threshold |
| Chunk overlap | `200` chars | `chunker.ts` | Overlap at hard-split boundaries |
| Ollama concurrency | `4` | `embedder.ts` | Parallel embed calls for Ollama |
| Bedrock concurrency | `10` | `embedder.ts` | Parallel embed calls for Bedrock |
| KB score threshold | `0.15` | `kb-searcher.ts` | Min score to include a KB result |

---

## 14. Build-Your-Own Recipe

Follow these numbered steps to create a pi extension with the same architecture.

### Step 1 — Scaffold the package

```bash
mkdir my-search-plugin && cd my-search-plugin
npm init -y
npm install tsx
npm install --save-dev @types/node esbuild
npm install --save-peer @mariozechner/pi-coding-agent @sinclair/typebox
```

Add to `package.json`:

```json
{
  "keywords": ["pi-package", "extension"],
  "pi": { "extensions": ["./src/index.ts"] }
}
```

### Step 2 — Implement the config loader (`src/config.ts`)

- Define a `Config` type with `dirs`, `fileExtensions`, `excludeDirs`, `dimensions`, `indexDir`, `provider`, and `knowledgeBases`.
- Read from a JSON file at `KNOWLEDGE_SEARCH_CONFIG ?? ~/.pi/knowledge-search.json`.
- Apply env-var overrides per field; expand `~` to `$HOME`.
- Return `null` when the plugin is unconfigured.

### Step 3 — Implement the chunker (`src/chunker.ts`)

- Short-circuit files ≤ `maxChunkSize`.
- Stage 1: split on H2–H6 headings; tag pre-heading content as `"intro"`.
- Stage 2: split sections on `\n\n`.
- Stage 3: hard-split chunks > `maxChunkSize` with a 200-char overlap.
- Stage 4: merge consecutive chunks < `minChunkSize`.

### Step 4 — Implement the embedder (`src/embedder.ts`)

- Define an `Embedder` interface with `embed()` and `embedBatch()`.
- Add a `truncate()` helper (10k char cap).
- Add `withRateLimitRetry()` with exponential back-off.
- Add `parallelMap()` for bounded concurrency.
- Implement one or more providers: `OpenAIEmbedder`, `BedrockEmbedder`, `OllamaEmbedder`.
- Export `createEmbedder(config, dimensions): Embedder`.

### Step 5 — Implement the index store (`src/index-store.ts`)

- Define `IndexEntry`, `IndexData`, and `SearchResult` types.
- On load: validate `version === INDEX_VERSION` and `dimensions === config.dimensions`; discard and re-index on mismatch.
- Key entries as `"absPath#chunkIndex"`.
- In `sync()`: scan files, diff vs stored mtimes, chunk new/changed files, build embed texts with `"Title: path > heading\n\ntext"`, call `embedBatch()` in batches of 50, store with mtime.
- In `search()`: embed query → dot-product over all vectors → sort → deduplicate to best chunk per file → threshold 0.15 → top N.
- Debounce saves by 5 s; flush immediately in `close()`.

### Step 6 — Implement the sync worker (`src/sync-worker.ts`)

- A plain Node.js script: `loadConfig() → createEmbedder() → KnowledgeIndex.loadSync() → sync() → stdout JSON → exit(0)`.
- Register `uncaughtException` / `unhandledRejection` → stderr + `exit(1)`.

Build it as an ESM bundle:

```json
"build:worker": "esbuild src/sync-worker.ts --bundle --format=esm --platform=node --outfile=dist/sync-worker.mjs"
```

### Step 7 — Implement the Bedrock KB searcher (`src/kb-searcher.ts`) *(optional)*

- Lazy-import the AWS SDK on first call.
- Cache one `BedrockAgentRuntimeClient` per `region:profile`.
- Fan-out with `Promise.all`, filter `score < 0.15`, normalise to `SearchResult`, append KB label.

### Step 8 — Wire up the entry point (`src/index.ts`)

```typescript
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (ctx) => { /* init + fork worker */ });
  pi.on("session_shutdown", async () => { /* close index */ });
  pi.registerTool({ name: "knowledge_search", ... });
  pi.registerCommand("/my-setup", ...);
}
```

- In `session_start`: `loadConfig() → createEmbedder() → KnowledgeIndex.loadSync() → fork("dist/sync-worker.mjs")`.
- Handle worker stdout JSON; call `index.loadSync()` and `ui.setStatus()` on success.
- Implement restart logic: max 3 restarts within 60 s.
- Call `worker.unref()`.

### Step 9 — Compile and install

```bash
npm run build:worker          # produces dist/sync-worker.mjs
pi install .                  # or: pi install git:github.com/yourname/my-search-plugin
```

---

## 15. Performance Benchmarks

From the project README:

| Operation | Measured time |
|---|---|
| Full index build | ~7 s |
| Incremental update (single file changed) | ~12 ms |
| Search query (embed + dot-product + format) | ~250 ms |
| Typical index file size | ~5 MB |

---

## 16. Gotchas and Design Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Slow I/O blocking the main event loop | Fork a child process for all sync work | Keeps pi responsive during embedding |
| ESM/CJS cycle with `tsx` on Node 25+ | Pre-compile sync worker with esbuild | `fork()` on a `.mjs` bundle sidesteps the resolution issue entirely |
| File watcher causing UI freezes | Removed; sync runs once on startup | Polling/watcher was not worth the instability |
| One file dominating results | Deduplicate to best chunk per file before returning | Prevents a large file with many matching chunks from pushing out other files |
| Embedding vectors must be comparable | Normalise all vectors to unit length | `dotProduct` then equals cosine similarity — no magnitude bias |
| AWS SDK adds load cost for non-AWS users | Dynamic `import()` on first KB/Bedrock call | Users without AWS credentials never load the SDK |
| Schema changes breaking existing indexes | `INDEX_VERSION` gate | Bumping the constant auto-rebuilds the index on next startup |
| Dimension mismatch (user changes provider) | Dimension check on load | Different models produce incompatible vector spaces; rebuild is mandatory |
| Rate limits from embedding APIs | `withRateLimitRetry` + exponential back-off | 1 s → 2 s → 4 s covers burst limits on all three supported providers |
| Huge files wasting embed budget | `truncate()` at 10k chars | Caps cost/time per chunk without losing the most relevant leading content |
| YAML frontmatter polluting chunk text | Strip `/^---\n[\s\S]*?\n---\n?/` before chunking | Metadata keys degrade semantic relevance |
| Embed text format matters | Prepend `"Title: path > section\n\n"` to every chunk | Improves semantic retrieval quality significantly |
| Save performance under rapid writes | 5-second debounce on `scheduleSave()` | Batches writes during bulk sync without risking data loss at shutdown |
| Node version requirement | Node 22.5+ (`node:sqlite` experimental) | `node:sqlite` used internally; Node 24+ recommended for stability |
