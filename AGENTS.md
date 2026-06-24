# omp-cmd — Command Code Provider for Oh My Pi

## Overview

**omp-cmd** is an omp plugin (extension) that registers `commandcode` as a model provider, connecting omp's agent runtime to [Command Code's API](https://commandcode.ai). It implements a custom streaming handler for the proprietary `/alpha/generate` endpoint, translates between omp's internal message format and Command Code's wire format, and auto-discovers available models from the Provider API.

This is a **third-party, unofficial plugin**. The upstream repo is [patlux/omp-commandcode](https://github.com/patlux/omp-commandcode); this fork strips OAuth callback-server complexity and simplifies authentication to a file-based API key approach.

## How omp Extensions Work

omp's extension system is defined in `@oh-my-pi/pi-coding-agent/extensibility/extensions`. An extension is an npm package with an `"omp"` field in `package.json` pointing to an entry module:

```json
{
  "omp": { "extensions": ["./index.ts"] }
}
```

The entry module exports a default **factory function** `(pi: ExtensionAPI) => void | Promise<void>`. The `ExtensionAPI` object provides methods to:

- **`pi.registerProvider(name, config)`** — register or override a model provider
- **`pi.registerTool(definition)`** — register a tool the LLM can call
- **`pi.registerCommand(name, options)`** — register a slash-command
- **`pi.on(event, handler)`** — subscribe to session lifecycle events
- **`pi.logger`**, **`pi.exec`**, **`pi.sendMessage`**, etc.

The `ProviderConfig` object accepts:

| Field | Purpose |
|---|---|
| `baseUrl` | API endpoint base URL |
| `apiKey` | API key or env var name |
| `api` | API type identifier |
| `streamSimple` | Custom streaming function (required for unsupported APIs) |
| `headers` | Custom HTTP headers |
| `authHeader` | If true, adds `Authorization: Bearer` |
| `models` | Static model list (mutually exclusive with `fetchDynamicModels`) |
| `fetchDynamicModels` | Async factory that fetches live models (runs through SQLite cache) |
| `oauth` | OAuth provider for `/login` support |

This plugin uses `registerProvider` + `streamSimple` + `fetchDynamicModels` + `oauth`.

## Architecture

```
index.ts              Entry point — extension factory
  │
  ├── src/core.ts     Streaming handler (streamCommandCode)
  ├── src/converters.ts  Message/tool/prompt conversion
  ├── src/models.ts   Model discovery from Provider API
  ├── src/oauth.ts    OAuth /login flow
  └── src/types.ts    Shared type guards
```

### File Responsibilities

#### `index.ts` — Extension entry point

The default export is the extension factory. It:

1. Ensures `~/.omp/agent/auth.json` exists (creates a placeholder template on first load).
2. Reads the API key from that file (returns `undefined` if placeholder or absent).
3. Fetches live models from Command Code's Provider API (`/provider/v1/models`), mapping each to a `ProviderModelConfig`.
4. Calls `pi.registerProvider("commandcode", { ... })` with:
   - A custom `streamSimple` handler (`streamCommandCode` from `core.ts`).
   - The model list from step 3.
   - An `oauth` provider backed by `src/oauth.ts`.
   - Hardcoded per-model pricing in `MODEL_COSTS` (fallback `ZERO_MODEL_COST` for unknown models).
   - Runtime overrides via `COMMANDCODE_API_BASE` and `COMMANDCODE_MODELS_URL` env vars.

#### `src/core.ts` — Streaming handler (`streamCommandCode`)

Implements the `(model, context, options) => AssistantMessageEventStream` contract that omp calls when the user selects a Command Code model.

**Request building:**
- Constructs a JSON body with `config` (working dir, date, git info), `params` (messages, tools, system prompt, model ID, streaming flag).
- Sets headers: `Authorization: Bearer <key>`, `x-command-code-version`, `x-cli-environment`, `x-project-slug`, `x-taste-learning`.
- Reads API key from `options.apiKey` (the resolved key from omp's auth pipeline), falling back to `converters.ts`'s `getApiKey()` (which searches `auth.json` locations).

**Streaming:**
- POSTs to `{apiBase}/alpha/generate`.
- Reads SSE or raw-JSONL response, parsing event lines via `parseStreamEventLine`.
- Dispatches events by type: `text-delta`, `reasoning-delta`, `reasoning-start`/`end`, `tool-call`, `finish`, `error`.
- Translates into omp's event stream (`text_start`/`delta`/`end`, `thinking_start`/`delta`/`end`, `toolcall_start`/`end`, `done`, `error`).
- Handles abort propagation from omp's `AbortSignal`.
- Retry: HTTP 429/5xx retries with `Retry-After` header support. Stream-level retry if no content has been produced yet (up to `DEFAULT_MAX_RETRIES` = 0 by default, i.e. disabled).

**Usage tracking:**
- Reads `totalUsage` from the `finish` event, extracts `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`.
- Computes cost from per-token model pricing.

#### `src/converters.ts` — Format translation

All omp→Command Code wire format conversions in one place:

- **`getApiKey()`** — reads API key from `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`, or `~/.commandcode/auth.json` (legacy fallback order). Supports `{"apiKey": "..."}`, `{"commandcode": "..."}`, and `{"credentials": {"apiKey": "..."}}` shapes.
- **`messagesToCC()`** — converts omp `Message[]` to Command Code message array. Handles: `user` (text only, images dropped), `system`/`developer` → `user`, `assistant` (text + thinking → `reasoning`, tool calls → `tool-call`), `toolResult` → `tool` with tool-result content blocks. Tracks and completes orphan tool-call IDs with empty results.
- **`toolsToJson()`** — converts omp `Tool[]` to JSON schema format.
- **`systemPromptToText()`** — flattens the system prompt (array of string/block entries) to plain text.
- **`parseStreamEventLine()`** — handles both SSE (`data: {...}`) and raw JSONL line formats.
- **`mapFinishReason()`** — maps Command Code finish reasons to omp's `"stop" | "length" | "toolUse" | "error"`.
- **`projectSlugFromPath()`** — derives a project slug from the working directory for the `x-project-slug` header.
- **`toJsonSchema()`** — converts omp's JSON Schema to the format Command Code expects.
- **`getEnvironmentInfo()`** — returns `"{platform}-{arch}, Node.js {version}"`.

#### `src/models.ts` — Model discovery

Fetches the live model list from `${DEFAULT_MODELS_URL}` (Provider API at `provider/v1/models`):

- Expects `{ object: "list", data: [{ id, name, context_length }] }`.
- Maps each to `{ id, name: "{name} (CC)", reasoning: true, contextWindow, maxTokens }`.
- 5-second fetch timeout.
- Throws on non-OK responses or parse failures.

`fetchCommandCodeModels` is the `fetchDynamicModels` factory — omp caches its result through the SQLite model cache (24h TTL, keyed by provider name).

#### `src/oauth.ts` — `/login` flow

Implements the `OAuthLoginCallbacks` interface for omp's `/login` command:

- **`login(callbacks)`** — opens browser to `https://commandcode.ai/api-keys`, then prompts the user to paste the generated API key into the TUI. Returns `OAuthCredentials` with the key as both `access` and `refresh`, and a 10-year expiry (Command Code keys don't expire).
- **`refreshToken(credentials)`** — no-op; returns the same credentials with an updated far-future expiry.
- **`getApiKey(credentials)`** — returns `credentials.access`.
- **`sanitizeApiKey(input)`** — strips common terminal paste wrappers (whitespace, control chars, quotes).

#### `src/types.ts` — Shared type guards

Minimal runtime type-checking helpers used across the other modules: `isRecord`, `stringValue`, `numberValue`, `booleanValue`, `recordOrEmpty`, `recordArray`.

## Data Flow

```
User types message
  │
  ▼
omp agent session (selects commandcode/* model)
  │
  ▼
omp resolves API key from auth pipeline
  │
  ▼
streamCommandCode(model, context, options)  [core.ts]
  │
  ├── Reads API key from options.apiKey or getApiKey()
  ├── Converts messages via messagesToCC()
  ├── Converts tools via toolsToJson()
  ├── Flattens system prompt via systemPromptToText()
  │
  ▼
HTTP POST {apiBase}/alpha/generate
  Headers: Authorization: Bearer, x-command-code-version, ...
  Body: { config, memory, params: { model, messages, tools, system, ... } }
  │
  ▼
Response stream (SSE or raw JSONL)
  │
  ▼
parseStreamEventLine(line)  →  { type, text, toolCallId, ... }
  │
  ▼
handleEvent(event) — dispatches by type:
  ├── text-delta         →  text_start / text_delta / text_end
  ├── reasoning-delta    →  thinking_start / thinking_delta
  ├── reasoning-start    →  end pending text block
  ├── tool-call          →  toolcall_start / toolcall_end
  ├── finish             →  usage tracking, map finish reason → done
  └── error              →  error
  │
  ▼
AssistantMessageEventStream → omp renders response
```

## Authentication

The plugin reads the API key from `~/.omp/agent/auth.json`. On first load it auto-creates the file with a placeholder:

```json
{ "commandcode": "user_xxxxxxxxxxxx" }
```

**Login via `/login`** (recommended):

1. Run `/login` in omp, select **Command Code**.
2. Browser opens to `commandcode.ai/api-keys`.
3. Generate an API key and paste it when prompted.
4. The key is saved to `~/.omp/agent/auth.json`.

**Manual:**
Place the key directly at the top level: `{"commandcode": "user_..."}` or `{"apiKey": "user_..."}`. The `getApiKey()` function in `converters.ts` also checks `~/.pi/agent/auth.json` and `~/.commandcode/auth.json` for backward compatibility.

## Model Discovery

Models are auto-discovered from the Command Code Provider API at `{baseUrl}/provider/v1/models`. Response format:

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "context_length": 131072 }
  ]
}
```

Each model gets:

- `id` — the raw model ID (used in `/switch commandcode/deepseek/deepseek-v4-pro`)
- `name` — display name with ` (CC)` suffix
- `reasoning` — always `true`
- `contextWindow` / `maxTokens` — from the API, `maxTokens` capped at `min(context_length, 65_536)`

Pricing is **hardcoded** in `MODEL_COSTS` in `index.ts`. Unknown models get `ZERO_MODEL_COST` (all zeros). This is a known maintenance burden — prices are display-only for omp's cost tracking.

Fetches go through omp's SQLite model cache (24h TTL). To bypass: restart omp or clear the cache.

## Key Design Decisions

### Why a custom `streamSimple` handler instead of reusing a built-in API type?

Command Code uses a proprietary `/alpha/generate` endpoint with a non-standard event format. It doesn't conform to OpenAI Chat Completions, Anthropic Messages, or any other built-in API dialect. The custom handler gives full control over request building, event parsing, retry logic, and abort propagation.

### No OAuth callback server

Simpler auth: `login()` opens the browser to the API keys page and asks the user to paste the key. No local HTTP server, no PKCE, no redirect handling. Command Code API keys don't expire, so `refreshToken` is a no-op.

### Minimal peer dependencies

All three peer deps (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-coding-agent`) are marked optional — the only import from a host package is the `ExtensionAPI` type. This means the plugin can be loaded without npm-installing the full omp dependency tree, relying on the host omp process to provide the types.

### No images

The `messagesToCC()` converter extracts text only from user messages — image blocks are dropped. Command Code's API accepts text content only in this plugin's current implementation.

### Retry is disabled by default

`DEFAULT_MAX_RETRIES = 0`. The retry infrastructure (429/5xx backoff, stream-level retry on empty responses) is wired in `core.ts` but inactive unless the constant is changed. This is a deliberate safety measure — retrying a partially-consumed stream could duplicate tool calls.

## Known Limitations / Warnings

- **Unofficial API.** The founder of Command Code has stated they may ban users of reverse-engineered APIs (see [issue #5](https://github.com/patlux/pi-commandcode-provider/issues/5)). The `$15` plan provides official Provider API access that doesn't need this plugin.
- **Pricing is hardcoded.** Unknown model IDs get zero cost, hiding real usage expense. Update `MODEL_COSTS` in `index.ts` when models change.
- **No images.** User messages with images drop the image content silently.
- **Tools and thinking are always enabled.** The plugin doesn't expose per-model capability toggles beyond the `reasoning: true` flag.
- **Stream-only.** The plugin implements only `streamSimple`, not a non-streaming completion path.

## Development

### Prerequisites

- [omp](https://omp.sh) installed
- [Bun](https://bun.sh)

### Setup

```bash
git clone https://github.com/bl4zee1g/omp-cmd.git
cd omp-cmd
omp plugin link .
```

Changes to `.ts` files are picked up immediately — no rebuild step.

### Structure

```
omp-cmd/
├── index.ts            # Extension entry point (registers the provider)
├── src/
│   ├── core.ts         # Streaming handler (custom API logic + retry)
│   ├── converters.ts   # Message/tool/prompt format translation
│   ├── models.ts       # Model discovery from Provider API
│   ├── oauth.ts        # OAuth /login flow
│   └── types.ts        # Shared type guards (isRecord, stringValue, …)
├── package.json        # npm package manifest with omp extension metadata
├── README.md           # User-facing docs (install, auth, usage)
├── CHANGELOG.md        # Per-release changelog
├── CONTRIBUTING.md     # Dev setup guide
├── LICENSE             # MIT
└── AGENTS.md           # This file — architecture and conventions
```

### Additional info

There's a high probability the user also has the source code of oh-my-pi along with its AGENTS.md and other docs cloned at ../oh-my-pi

Commandcode often changes their authorization headers and other things, if the user says they're getting some sort of Invalid Authorization error there's a high likelihood it got changed again. In that case, you can use the locally installed officiall commandcode cli to compare the headers and other things. For just a quick check, you can run
``` bash
cmd -p [test prompt]
```

### Conventions

- **No build step.** Source `.ts` files are consumed directly by omp via Bun's TypeScript runtime.
- **No tests.** Currently no test infrastructure. Changes are validated by manual omp sessions.
- **No separate auth module for omp.** Auth reads from `~/.omp/agent/auth.json` only — no env vars (`COMMANDCODE_API_KEY` was dropped in v0.1.0).
- **All wire-format conversion in `converters.ts`.** Keep it there — don't scatter format logic across modules.
- **Type guards in `types.ts`.** Runtime type narrowing helpers centralised; `isRecord`, `stringValue`, `numberValue` appear in every module.
- **Changelog in `CHANGELOG.md`** under `## [Unreleased]` sections per omp convention (Breaking / Added / Changed / Fixed / Removed).

### Release

1. Update `version` in `package.json`.
2. Move `[Unreleased]` changelog entries to a new release section.
3. Tag and publish to npm.
