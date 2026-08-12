# LeiAI API Gateway — CLAUDE.md

## Project Overview

OpenAI-compatible API load balancer built with **Bun + Hono**. Distributes LLM requests across multiple backends with round-robin routing, health checks, SOCKS5 proxy support, and API key authentication.

## Architecture

```
src/
├── index.ts                      # Entry point: orchestration
├── api/
│   ├── index.ts                  # Hono app wrapper (init, start, stop)
│   ├── utils/
│   │   └── apiVersionRouter.ts   # Abstract base for version routers
│   └── versions/
│       └── v1/
│           ├── index.ts          # APIv1Router: mounts auth + routes
│           ├── auth.ts           # Auth middleware (Bearer OR x-api-key)
│           └── routes/
│               ├── openai.ts     # OpenAI-compatible proxy routes (+ /models)
│               ├── anthropic.ts  # Anthropic Messages proxy route (/messages)
│               └── responses.ts  # OpenAI Responses proxy route (/responses)
├── loadBalancing/
│   ├── providerManager.ts        # Provider registry, init, model/health refresh
│   ├── loadBalancer.ts           # Round-robin backend selection, proxy forwarding
│   ├── healthMonitor.ts          # Per-backend health tracking with exponential backoff
│   ├── backendAPIClient.ts       # HTTP/S + SOCKS5 proxy client (per-request auth mode)
│   └── providerModelsIndex.ts    # Fetches /v1/models, merges across healthy backends
├── translation/                  # API-format translation (Anthropic <-> OpenAI Chat)
│   ├── types.ts                  # OpenAI Chat / Anthropic / Responses type defs
│   ├── chatAnthropic.ts          # Request + non-streaming response converters
│   ├── sse.ts                    # SSE streaming converters + model-rewrite passthrough
│   └── index.ts                  # Public exports
└── utils/
    ├── index.ts                  # Helpers: random, sleep, URL parsing, etc.
    ├── logger.ts                 # Leveled logger with ISO timestamps
    ├── cron.ts                   # Cron job manager (health + model refresh)
    └── config/
        ├── index.ts              # Env var loading (LAG_LOG_LEVEL, LAG_HOST, etc.)
        ├── gatewayConfig.ts      # gateway.json validation (Zod)
        └── apiKeysConfig.ts      # api-keys.json validation (Zod)
```

## Data Flow

1. **Startup**: `Main.main()` → load env vars → load `gateway.json` + `api-keys.json` → init `ProviderManager` (creates `BackendAPIClient` + `HealthMonitor` + `ProviderModelsIndex` per provider) → start cron jobs → start Hono server.
2. **Request**: Client sends `Authorization: Bearer <key>` (OpenAI style) **or** `x-api-key: <key>` + `anthropic-version` (Anthropic style) → `authMiddlewareV1` validates against `api-keys.json` → route resolves model (handles `provider/model` format and `customModels` alias) → `LoadBalancer` picks healthy backend via round-robin → `BackendAPIClient` proxies the request (HTTP or SOCKS5). Anthropic-style requests to `/v1/messages` are either passed through natively (if the provider `supportsAnthropicLikeAPI`) or translated to OpenAI chat-completions via the `translation/` module before forwarding; the response is translated back.
3. **Health**: Cron job every 5 min calls `refreshHealthMonitorData()` → for each backend, runs a lightweight request → marks unhealthy after 3 consecutive failures → exponential backoff on timeout (1s → 30s max, 2^n).
4. **Models**: Cron job calls `refreshModelsData()` → fetches `/v1/models` from all backends of each provider → keeps only models present on **every** healthy backend → exposed at `GET /v1/models` as `providerId/modelName`.

## Key Conventions

- **Config format**: JSON files in `config/`:
  - `gateway.json` — array of providers, each with `id`, `name`, `backends[]` (each: `name`, `baseUrl`, optional `apiKey`, optional `proxyUrl`), optional `supportsAnthropicLikeAPI` (default `false`), optional `customModels.mapping` (record of alias → `providerId/modelName` or `{ target, aliases }`)
  - `api-keys.json` — flat record of API key → `{ description?, allowedModels[], denyModels[] }`
- **Env vars**: `LAG_LOG_LEVEL`, `LAG_LOG_DEBUG_FULL_REQUEST`, `LAG_LOG_DEBUG_FULL_RESPONSE`, `LAG_HOST`, `LAG_PORT` (default 12117), `LAG_CONFIG_BASE_DIR` (default `./config`)
- **Client API surfaces** (all under `/v1`):
  - OpenAI-compatible: `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/embeddings`, `GET /v1/models` (OpenAI list envelope)
  - Anthropic-compatible: `POST /v1/messages` (Anthropic Messages API). `GET /v1/models` returns the Anthropic envelope (`data[]` with `display_name`/`created_at`, `has_more`, `first_id`, `last_id`) when the client authenticated via `x-api-key`.
  - OpenAI Responses: `POST /v1/responses` (the newer Responses API). Since backends speak chat-completions, Responses requests are **translated** to `/chat/completions` and the response (streaming and non-streaming) is translated back into the Responses event/object format.
  - Backends always speak OpenAI chat-completions. A `/v1/messages` request is **translated** to `/chat/completions` (request + response, streaming and non-streaming) unless the provider sets `supportsAnthropicLikeAPI: true`, in which case it is **forwarded natively** to the backend's `/v1/messages` with `x-api-key` + `anthropic-version` auth (passthrough, model name rewritten).
- **Model IDs**: Exposed as `providerId/modelName` (e.g., `openai/gpt-4`). Aliases via `customModels.mapping`.
- **Auth**: The same gateway API key may be presented either as `Authorization: Bearer <key>` (OpenAI style) or `x-api-key: <key>` (Anthropic style); both are validated against `api-keys.json`. Has `allowedModels`/`denyModels` per key (mutually exclusive).
- **Default port**: 12117, **host**: `::` (IPv6 any).
- **Package manager**: Bun. ESM modules (`"type": "module"`).
- **Compiler**: TypeScript with strict mode, `verbatimModuleSyntax`, `moduleResolution: "bundler"`.

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Dev mode with hot reload |
| `bun start` | Production start (via `scripts/entrypoint.ts`) |
| `bun test` | Run all tests |
| `bun run typecheck` | TypeScript type checking |
| `bun run compile` | Compile binary (uses `@cleverjs/cli`, builds linux-x64/arm64) |
| `bun run compile -- --target linux-x64` | Compile for specific target |

## Testing

Tests use Bun's built-in test runner. Fake backends provided by `tests/helpers/fakeOpenAICompatibleAPI.ts` and `tests/helpers/fakeAnthropicAPI.ts`. SOCKS5 test server in `tests/helpers/socks5server/`.

- `tests/smoke.test.ts` — basic imports and module checks
- `tests/unit.test.ts` — config parsing, algorithms, headers
- `tests/integration.test.ts` — request forwarding, failover
- `tests/socks5-streaming.test.ts` — SOCKS5 proxy + streaming
- `tests/openai-integration.test.ts` — OpenAI-compatible endpoint testing (incl. `@ai-sdk/openai-compatible`)
- `tests/anthropic-translation.test.ts` — Anthropic↔OpenAI translation converters + `/v1/messages` endpoint (translation + passthrough) with a fake Anthropic backend
- `tests/responses-translation.test.ts` — Responses↔chat converters + `/v1/responses` endpoint
- `tests/ai-sdk-clients.test.ts` — end-to-end with REAL `@ai-sdk` clients (`@ai-sdk/anthropic`, `@ai-sdk/openai` Responses, `@ai-sdk/openai-compatible`) against a realistic `@copilotkit/aimock` `LLMock` backend (multi-chunk SSE + tool calls); proves text + tool-call round-trips, streaming and non-streaming, through every translated endpoint.

## Docker / Deployment

- **Dockerfile**: Multi-stage. Runtime is `debian:stable-slim`, copy compiled binary from `build/bin/`. Exposes 12117. Non-root user.
- **docker-compose**: Uses `gcr.leicraftmc.de/leicraftmc/leiai/api-gateway:latest`, mounts config, healthcheck.
- **CI**: GitLab CI via `.gitlab-ci.yml` — test stage (typecheck + unit), build stage (compile binary + Docker push).
- **Compile targets**: `linux-x64`, `linux-x64-baseline`, `linux-arm64`.

## Code Style Notes

- Classes with static methods used as modules (e.g., `ConfigHandler`, `Logger`, `ProviderManager`).
- Namespace pattern used for types (e.g., `GatewayConfig.Types.ConfigSchema`).
- `zod` for all config validation.
- Manual HTTP/1.1 over SOCKS5 in `BackendAPIClient` — no library abstraction.
- Health monitor uses Set for healthy/unhealthy indices, Map for timestamps.
- Error handling: `Logger.error`/`Logger.critical` + graceful shutdown on uncaught exceptions/rejections.
