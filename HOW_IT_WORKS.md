# How pi-memory Works

A developer guide to the internals of the **pi-memory** plugin — useful if you want to understand the design or build a similar persistent-memory extension for the `pi` coding agent.

---

## 1. Overview

`pi-memory` is a persistent, cross-session memory extension for the `pi` coding agent. It solves the problem that every pi session starts with a blank slate: if you corrected a mistake last Tuesday, pi will repeat it next Monday.

The plugin does three things automatically:

1. **Injects** relevant remembered facts and lessons into the system prompt at the start of every agent turn.
2. **Learns** from the conversation at session end — an LLM pass extracts structured preferences, project patterns, and corrections.
3. **Exposes tools** so the agent (and you) can query, add, or delete memories explicitly.

A companion CLI script (`bootstrap.ts`) can seed the database from historical session-search indexes, but it is not part of the runtime.

---

## 2. Architecture

```
src/
├── index.ts        ← Plugin entry point. Session state, lifecycle hooks, tools, command.
├── store.ts        ← SQLite persistence (MemoryStore). Three tables + FTS5 search.
├── consolidator.ts ← LLM extraction pipeline. Prompt → parse → filter → write.
├── injector.ts     ← Context builder. Assembles <memory> XML block for system prompt.
└── bootstrap.ts    ← One-shot CLI seed (not part of runtime).
```

| Module | Responsibility |
|---|---|
| **`index.ts`** | Owns all mutable session state (`store`, message queues, `sessionCwd`). Wires 5 lifecycle hooks, registers 5 tools + 1 command. |
| **`store.ts`** | `MemoryStore` class wrapping `node:sqlite`. Schema migrations, FTS5 virtual tables, Jaccard dedup, confidence-wins upsert, WAL mode. |
| **`consolidator.ts`** | Builds the LLM consolidation prompt, parses the JSON response, applies the ephemeral filter, and writes approved entries to the store. |
| **`injector.ts`** | `buildContextBlock()` — builds the `<memory>…</memory>` XML block injected into `systemPrompt`. Handles selective vs. fallback mode, staleness annotations, and the 8 000-char cap. |

---

## 3. Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ session_start                                                   │
│   resolveDbPath(cwd) → open MemoryStore (WAL SQLite)           │
│   seed pendingUserMessages / pendingAssistantMessages           │
│   from session history (for /resume support)                   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ before_agent_start  (fires before every LLM turn)              │
│   injector.buildContextBlock(store, cwd, prompt, config)       │
│     ├── searchSemantic(prompt, 15)   FTS5 BM25 relevance       │
│     ├── searchSemantic(projectSlug, 5) project scoping         │
│     ├── lessons: all | selective (FTS + category filter)       │
│     ├── format with staleness tags  (30d / 90d thresholds)     │
│     └── wrap in <memory>…</memory>, cap at 8 000 chars         │
│   return { systemPrompt: original + "\n\n" + contextBlock }    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ agent_end  (fires after every LLM turn)                        │
│   append user messages  → pendingUserMessages  (cap 60)        │
│   append assistant messages → pendingAssistantMessages (cap 60)│
└──────────────────────────────┬──────────────────────────────────┘
                               │
           session_before_switch (≥3 msgs) or session_shutdown
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ consolidateSession()                                            │
│   buildConsolidationPrompt(msgs, currentFacts, currentLessons) │
│   pi.exec("pi", ["-p", prompt, "--print", "--no-extensions",   │
│            "--model", "claude-sonnet-4-20250514"],             │
│            { timeout: 45_000 })                                │
│   parseConsolidationResponse(stdout)  → ExtractedMemory        │
│   applyExtracted(store, extracted)                             │
│     ├── isDerivableOrEphemeral() filter on semantic entries    │
│     ├── isDerivableLesson() filter on lessons                  │
│     ├── store.setSemantic()  (confidence-wins upsert)          │
│     └── store.addLesson()    (exact + Jaccard dedup)           │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                  session_shutdown → store.close()
```

---

## 4. Storage Layer

### Location

| Condition | Path |
|---|---|
| `"pi-memory".localPath` set in `{cwd}/.pi/settings.json` | `{localPath}/memory.db` |
| Otherwise | `~/.pi/memory/memory.db` |

### Schema

```sql
-- Key-value facts: preferences, project patterns, tool notes
CREATE TABLE semantic (
  key          TEXT PRIMARY KEY,           -- lowercase, dot-separated  e.g. pref.commit_style
  value        TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.8,  -- [0,1]; higher wins on conflict
  source       TEXT NOT NULL DEFAULT 'consolidation',  -- 'user'|'consolidation'|'correction'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT                        -- set by touchAccessed() during injection
);

-- Learned corrections / validated approaches
CREATE TABLE lessons (
  id         TEXT PRIMARY KEY,   -- UUID
  rule       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  source     TEXT NOT NULL DEFAULT 'consolidation',
  negative   INTEGER NOT NULL DEFAULT 0,  -- 1 = DON'T do this
  is_deleted INTEGER NOT NULL DEFAULT 0,  -- soft-delete flag
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,   -- 'create'|'update'|'delete'
  memory_type TEXT NOT NULL,   -- 'semantic'|'lesson'
  memory_key  TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

SQLite is opened in WAL mode (`PRAGMA journal_mode = WAL`) with a 5-second busy timeout. Every mutating operation runs inside a `BEGIN IMMEDIATE … COMMIT` transaction via `withLock()`.

### Search Strategy

Both `semantic` and `lessons` have FTS5 virtual tables (`semantic_fts`, `lessons_fts`) maintained by `AFTER INSERT / UPDATE / DELETE` triggers. Search splits the query into terms and builds an OR FTS5 query with BM25 ranking:

```sql
SELECT s.*
FROM semantic s
JOIN semantic_fts fts ON s.rowid = fts.rowid
WHERE semantic_fts MATCH '"term1" OR "term2"'
ORDER BY bm25(semantic_fts)
LIMIT ?
```

If FTS5 is unavailable (`SQLITE_ENABLE_FTS5` not compiled in), a substring-scoring fallback is used: each entry is scored by the fraction of query terms it contains.

### Deduplication Rules

| Layer | Rule |
|---|---|
| **Semantic — confidence wins** | `setSemantic()` silently drops the write if `existing.confidence > incoming.confidence`. |
| **Lessons — exact match** | `LOWER(TRIM(rule))` equality check against non-deleted rows. |
| **Lessons — Jaccard ≥ 0.7** | Token-level Jaccard similarity across all existing rules. Rejected if ≥ 0.7. |
| **Lessons — soft delete** | `deleteLesson()` sets `is_deleted = 1`; all queries filter `is_deleted = 0`. Supports UUID prefix matches (first 8 chars). |

Key normalization: `setSemantic()` lowercases the key before every read/write.

---

## 5. Consolidation Pipeline

### When It Runs

- **`session_shutdown`** — always attempted if `pendingUserMessages.length >= 3`.
- **`session_before_switch`** — same threshold, triggered by `/new` or `/resume`.
- **`/memory-consolidate` command** — manual trigger, threshold lowered to 2.

### Prompt Construction (`buildConsolidationPrompt`)

```
CONSOLIDATION_PROMPT            (static instruction block, ~900 chars)
  + Current Memory State        (up to 1 500 chars of existing facts,
                                 up to 500 chars of existing lessons)
  + Working directory line
  + Conversation (interleaved)  (up to 30 user/assistant pairs,
                                 user truncated to 1 000 chars,
                                 assistant truncated to 500 chars)
```

The memory-state section lets the LLM avoid emitting duplicates it already knows about.

### LLM Call

```ts
pi.exec("pi", [
  "-p", prompt,
  "--print",
  "--no-extensions",
  "--model", "claude-sonnet-4-20250514",
], { timeout: 45_000, cwd: sessionCwd })
```

`pi.exec` spawns a headless pi session. `--no-extensions` prevents recursive plugin loading. The 45-second timeout and a silent catch ensure the plugin never blocks or crashes pi on shutdown.

### Response Parsing (`parseConsolidationResponse`)

The LLM is instructed to respond with pure JSON. The parser accepts both bare JSON and JSON wrapped in a markdown code block (` ```json … ``` `). It applies two filters:

**Semantic entries accepted when:**
- `confidence >= 0.8`
- Key matches `/^[a-z][a-z0-9._-]*$/` and is 2–100 chars
- Value is ≤ 500 chars

**Lesson entries accepted when:**
- `rule` is a non-empty string (category defaults to `"general"`, `negative` defaults to `false`)

### Ephemeral Filter (`applyExtracted`)

Before writing to the store, `applyExtracted()` runs two filter functions:

**`isDerivableOrEphemeral(key, value)`** — rejects semantic entries that are:
- File paths / directories (key contains `filepath`, `file_path`, `directory`)
- Project structure patterns (`project.<name>.path|dir|location|structure|layout|architecture`)
- Git history (`commit`, `git.history`, `git.recent`)
- Activity summaries (value starts with `"today "`, `"we worked on"`, `"this session"`)
- Inline code blocks > 300 chars
- Temporary investigation state (`current_task`, `in_progress`, `investigating`)

**`isDerivableLesson(rule)`** — rejects lessons that are:
- `"file X is at path Y"` patterns
- `"the project/codebase uses X"` (obvious from config files)
- Pure activity logs (`"we/I/the agent fixed/deployed/updated …"`)
- Error→command recipes (`"when error X, run: Y"`)
- Lines starting with `"run: "` or containing `"command exited with code"`

---

## 6. Injection

`buildContextBlock(store, cwd, prompt, config)` is called in `before_agent_start`. It returns `{ text, stats }`. If `text` is empty nothing is added to the system prompt.

### Selective mode (prompt provided — normal path)

1. `searchSemantic(prompt, 15)` — FTS BM25 search against user's current message.
2. If `cwd` resolves to a project slug, also `searchSemantic(slug, 5)` and merge/dedup.
3. Call `store.touchAccessed(keys)` to timestamp the injected entries.
4. **Lessons** — behaviour depends on `lessonInjection` setting:
   - `"all"` (default): `listLessons(undefined, 50)`
   - `"selective"`: FTS search by prompt + project slug + always include `"general"` category, capped at 15.

### Fallback mode (no prompt)

Prefix-list dump: `pref.*` (50), `project.*` filtered by project slug or confidence ≥ 0.9 (50), `tool.*` (20), all lessons (50), `user.*` (10).

### Output format

```xml
<memory>
## Relevant Memory
- commit_style: conventional commits
- rosie.di: Dagger dependency injection (42d ago)
- old-pref: something ⚠️ 95d old — verify before acting on this

## Learned Corrections
- DON'T: use echo >> for vault notes, use sed [vault]

## Validated Approaches
- Draft wiki changes and let user preview before publishing [wiki-edit]

## Before acting on memory
- Memory records can become stale. If a memory names a file, function,
  or flag — verify it still exists before recommending it. ...
</memory>
```

Key stripping: the leading prefix segment (e.g. `pref.`) is removed for readability — the key displayed is everything after the first dot.

### Staleness Annotations

| Age | Tag |
|---|---|
| 30 – 89 days | `(Nd ago)` |
| ≥ 90 days | `⚠️ Nd old — verify before acting on this` |

### Size cap

Hard cap at **8 000 characters**. If the assembled block exceeds this, it is sliced and closed with `\n... (truncated)\n</memory>`.

---

## 7. Lifecycle Hooks

| Hook | Trigger condition | What happens |
|---|---|---|
| `session_start` | Session opens | `resolveDbPath(cwd)` → `new MemoryStore(path)`. Seeds message buffers from `ctx.sessionManager.getBranch()` (for `/resume`). Shows `"Memory: N facts, M lessons"` in status bar for 5 s. |
| `before_agent_start` | Before each LLM agent turn | `buildContextBlock()` → prepend to `event.systemPrompt`. No-op if context is empty. |
| `agent_end` | After each LLM agent turn | Appends user + assistant messages to rolling buffers, each capped at 60 entries (oldest dropped). |
| `session_before_switch` | User runs `/new` or `/resume` | If `pendingUserMessages.length >= 3`, runs `consolidateSession()` and shows spinner. Resets buffers. |
| `session_shutdown` | Session exits (exit / C-c C-c) | Shows spinner, runs `consolidateSession()` if ≥ 3 user messages, calls `store.close()`. All failures silently swallowed. |

---

## 8. Tools & Commands

### Tools (available to the agent)

| Tool | Parameters | Effect |
|---|---|---|
| `memory_search` | `query: string`, `limit?: number` | FTS/BM25 search of semantic table. Returns `key: value (confidence, source)` lines. |
| `memory_remember` | `type: "fact"\|"lesson"`, `key?`, `value?`, `rule?`, `category?`, `negative?: boolean` | `setSemantic(key, value, 0.95, "user")` or `addLesson(rule, …)`. Confidence 0.95 beats most consolidation entries. |
| `memory_forget` | `type`, `key?` (fact) or `id?` (lesson) | `deleteSemantic(key)` or `deleteLesson(id)`. Lesson id may be a UUID prefix. |
| `memory_lessons` | `category?: string`, `limit?: number` | `listLessons(category, limit)`. Returns formatted list with ✅/❌ prefix. |
| `memory_stats` | *(none)* | `store.stats()` → count of semantic, active lessons, events + resolved DB path. |

All tools defensively `stripQuotes()` string arguments to handle double-encoded JSON from misbehaving local model runners.

### Command

| Command | Minimum messages | Effect |
|---|---|---|
| `/memory-consolidate` | 2 user messages | Manually triggers `consolidateSession()` and shows updated stats. |

---

## 9. Configuration

All settings live in `settings.json` (global: `~/.pi/agent/settings.json`; per-project: `{cwd}/.pi/settings.json`). Per-project values override global ones.

### `"memory"` key (injection behaviour)

```jsonc
// ~/.pi/agent/settings.json  OR  {cwd}/.pi/settings.json
{
  "memory": {
    "lessonInjection": "all"   // "all" (default) | "selective"
  }
}
```

| Key | Values | Default | Effect |
|---|---|---|---|
| `memory.lessonInjection` | `"all"` / `"selective"` | `"all"` | Controls which lessons are injected. `"selective"` filters to ≤ 15 relevant lessons via FTS + category inference. |

### `"pi-memory"` key (storage)

```jsonc
// {cwd}/.pi/settings.json
{
  "pi-memory": {
    "localPath": "./memory"   // directory; memory.db created inside
  }
}
```

| Key | Default | Effect |
|---|---|---|
| `pi-memory.localPath` | *(unset → global)* | Store a per-project `memory.db` instead of the shared `~/.pi/memory/memory.db`. Useful for project-specific memory isolation. |

---

## 10. Plugin Registration

The sole mechanism pi uses to discover an extension is the `"pi"` field in `package.json`:

```jsonc
// package.json
{
  "name": "@yourscope/my-pi-plugin",
  "pi": {
    "extensions": [
      "./src/index.ts"   // relative path to the entry point
    ]
  }
}
```

**Key points:**

- Ship **raw TypeScript source** — pi runs it via `tsx` at load time. No build step needed.
- `outDir` in `tsconfig.json` is only used for `tsc --noEmit` type-checking; there is no `dist/` at runtime.
- Peer deps `@mariozechner/pi-coding-agent` (for `ExtensionAPI` type) and `@sinclair/typebox` (for tool parameter schemas) must be listed as `peerDependencies`.
- Node ≥ 22 is required (`node:sqlite` is the built-in SQLite binding used by this plugin).
- Tests use Node's native `--test` runner: `node --test --import tsx src/**/*.test.ts`.

---

## 11. Developer Guide: Building a Similar Plugin

### Minimal skeleton

```ts
// src/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // ── Session state ──────────────────────────────────────────────
  let myState: string | null = null;

  // ── Lifecycle hooks ────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    myState = ctx.cwd;
    ctx.ui.setStatus("my-plugin", "Ready");
    setTimeout(() => ctx.ui.setStatus("my-plugin", ""), 3000);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    // Return a mutated systemPrompt to inject context
    const extra = myState ? `\n\nCurrent project: ${myState}` : "";
    if (!extra) return;          // returning undefined = no change
    return { systemPrompt: event.systemPrompt + extra };
  });

  pi.on("agent_end", async (event, _ctx) => {
    // Inspect messages after each LLM turn
    for (const msg of event.messages) { /* ... */ }
  });

  pi.on("session_before_switch", async (_event, _ctx) => {
    // Flush state before /new or /resume
    myState = null;
  });

  pi.on("session_shutdown", async () => {
    // Final cleanup — must not throw
    myState = null;
  });

  // ── Tool registration ──────────────────────────────────────────
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    parameters: Type.Object({
      input: Type.String({ description: "The input" }),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      return {
        content: [{ type: "text", text: `Got: ${params.input}` }],
        details: {},
      };
    },
  });

  // ── Command registration ───────────────────────────────────────
  pi.registerCommand("my-command", {
    description: "Manually trigger something",
    async handler(_args, ctx) {
      ctx.ui.notify("Command executed", "info");
    },
  });
}
```

### Patterns to replicate

| Pattern | Where in pi-memory | Why |
|---|---|---|
| **`resolveDbPath(cwd)`** before opening any per-session resource | `index.ts` `session_start` | Allows per-project isolation via local settings. |
| **Read config from both global and local `settings.json`**, local wins | `readSettingsConfig()` in `index.ts` | Users can override global defaults per project. |
| **Rolling message buffers** capped at N, seeded from session history | `agent_end` + `session_start` branch walk | Prevents unbounded memory growth; supports `/resume`. |
| **`pi.exec("pi", ["-p", …, "--no-extensions"])` for LLM calls** | `consolidateSession()` | Avoids recursive plugin loading; uses the same model/auth context. |
| **Silent catch on all shutdown code** | `session_shutdown` | pi must exit cleanly even if the plugin errors. |
| **FTS5 with substring fallback** | `store.ts` `searchSemantic()` | `node:sqlite` may lack FTS5 depending on the distribution. |
| **Confidence-wins upsert** | `store.ts` `setSemantic()` | High-confidence user-set values survive future LLM consolidation. |
| **Jaccard dedup before inserting learned rules** | `store.ts` `addLesson()` | Prevents near-duplicate rules accumulating over many sessions. |
| **`stripQuotes()` on tool params** | `index.ts` tool handlers | Local model runners sometimes double-JSON-encode string arguments. |
| **Inject as `<memory>…</memory>` XML** | `injector.ts` | Gives the agent a visually distinct section it can reference by name. |
| **Staleness annotations in injected text** | `injector.ts` `formatSemantic()` | Prevents the agent from treating old remembered facts as current truth. |
| **Ephemeral filter before writing** | `consolidator.ts` `applyExtracted()` | Keeps the store signal-rich; file paths and activity logs pollute memory. |

### Key constraints

- **Node ≥ 22** required for `node:sqlite`.
- **FTS5** requires SQLite compiled with `SQLITE_ENABLE_FTS5`; always provide a fallback.
- **`--no-extensions`** when calling `pi.exec` is critical to avoid infinite recursion.
- All `session_shutdown` code must be wrapped in try/catch — pi cannot recover from an extension throwing here.
- The `"pi": { "extensions": ["./src/index.ts"] }` field in `package.json` is the **only** registration mechanism; the path must point to the default-exporting TypeScript file.
