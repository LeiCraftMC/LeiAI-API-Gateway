# LeiAI API Gateway

A high-performance OpenAI-compatible API load balancer built with **Bun + Hono**. Distributes LLM requests across multiple backends with round-robin routing, health checks, SOCKS5 proxy support, and API key authentication.

## Features

- **Round-robin load balancing** — Automatically distributes requests across healthy backends per provider
- **Multi-provider support** — Define multiple LLM providers, each with its own backends and health tracking
- **Full streaming support** — OpenAI streaming completions, SSE, and any chunked transfer encoding through both direct and SOCKS5 proxy backends
- **Health checks with auto-failover** — Continuous monitoring of backend availability; unhealthy backends are skipped after 3 consecutive failures
- **API key management** — Per-backend API keys + client authentication with `allowedModels`/`denyModels` scoping
- **SOCKS5 proxy support** — Route backend requests through SOCKS5 proxies, including streaming
- **OpenAI-compatible endpoints** — Drop-in replacement for OpenAI's `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, and `/v1/models`
- **Custom model aliases** — Map friendly model names to `provider/model` IDs
- **JSON configuration** — Simple `providers.json` and `api-keys.json` config files
- **Graceful shutdown** — Handles SIGINT, SIGTERM, uncaught exceptions, and unhandled rejections

## Installation

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
```

## Configuration

Create `config/providers.json` with your LLM provider backends:

```json
{
  "providers": [
    {
      "id": "my-provider",
      "name": "My LLM Provider",
      "backends": [
        {
          "name": "Local LLM Server",
          "baseUrl": "http://localhost:8000"
        },
        {
          "name": "Remote LLM via Proxy",
          "baseUrl": "http://remote-llm.example.com:8000",
          "apiKey": "your-api-key",
          "proxyUrl": "socks5://user:password@proxy.example.com:1080"
        }
      ]
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "backends": [
        {
          "name": "OpenAI Official",
          "baseUrl": "https://api.openai.com",
          "apiKey": "sk-your-api-key-here"
        }
      ]
    }
  ],
  "customModels": {
    "mapping": {
      "gpt-4": "openai/gpt-4",
      "gpt-3.5": "openai/gpt-3.5-turbo"
    },
    "ownerID": "custom-owner"
  }
}
```

Create `config/api-keys.json` with your client API keys:

```json
{
  "my_apikey_1": {
    "description": "This is my first API key",
    "allowedModels": ["gpt-4", "gpt-3.5-turbo"]
  },
  "my_apikey_2": {
    "description": "This is my second API key",
    "denyModels": ["gpt-4"]
  },
  "my_apikey_3": {}
}
```

### Configuration Options

#### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LAG_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`, `critical` |
| `LAG_HOST` | `::` | Server bind address (IPv6 any) |
| `LAG_PORT` | `12117` | Server listen port |
| `LAG_CONFIG_BASE_DIR` | `./config` | Config directory path |

#### `providers.json` — Provider/Backend Options

| Field | Description |
|---|---|
| `providers[].id` | Unique provider ID (lowercase letters, numbers, and hyphens) |
| `providers[].name` | Human-readable provider name |
| `providers[].backends[].name` | Unique name for this backend |
| `providers[].backends[].baseUrl` | Full URL to the OpenAI-compatible backend |
| `providers[].backends[].apiKey` | (optional) API key injected into requests to this backend |
| `providers[].backends[].proxyUrl` | (optional) SOCKS5 proxy URL (e.g., `socks5://user:pass@host:1080`) |
| `customModels.mapping` | (optional) Map model aliases → `providerId/modelName` values |
| `customModels.ownerID` | (optional) Custom owner ID shown in `/v1/models` |

#### `api-keys.json` — API Key Options

| Field | Description |
|---|---|
| `<api-key>` | The API key string clients use in `Authorization: Bearer <key>` |
| `<key>.description` | (optional) Human-readable description |
| `<key>.allowedModels` | (optional) Array of model names this key is allowed to use |
| `<key>.denyModels` | (optional) Array of model names this key is **not** allowed to use |

> **Note**: `allowedModels` and `denyModels` are mutually exclusive per API key.

## Usage

### Start the server

```bash
# Development with hot reload (source maps and all)
bun run dev

# Production
bun start

# With custom config directory
LAG_CONFIG_BASE_DIR=/etc/leiai/config bun start
```

### Using the load balancer

Once running, use it like the OpenAI API — models are available as `providerId/modelName`:

```bash
curl http://localhost:12117/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my_apikey_1" \
  -d '{
    "model": "openai/gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Using custom model aliases

If you defined `customModels.mapping`, use the alias instead of the full provider/model path:

```bash
curl http://localhost:12117/v1/chat/completions \
  -H "Authorization: Bearer my_apikey_1" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming responses

Streaming works with both direct and SOCKS5 proxy backends:

```bash
curl http://localhost:12117/v1/chat/completions \
  -H "Authorization: Bearer my_apikey_1" \
  -d '{
    "model": "openai/gpt-4",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

### Health check

Check the status of all backends across all providers:

```bash
curl http://localhost:12117/_health
```

Response:
```json
{
  "status": "healthy",
  "backends": [
    {
      "name": "my-provider/Local LLM Server",
      "healthy": true,
      "lastCheck": "2024-01-15T10:30:45.123Z",
      "consecutiveFailures": 0
    }
  ]
}
```

### List available models

```bash
curl http://localhost:12117/v1/models \
  -H "Authorization: Bearer my_apikey_1"
```

## How It Works

### Load Balancing
- Each provider maintains its own round-robin across its backends
- Unhealthy backends are automatically skipped
- If all backends of a provider are unhealthy, all of them are tried as a fallback
- Backend selection is per-request, ensuring even distribution

### Health Checks
- Runs every 5 minutes via cron
- Each backend is checked by making a lightweight request
- A backend is marked **unhealthy** after 3 consecutive failures
- Health status uses exponential backoff for retry timeouts (1s → 30s max)
- A backend recovers immediately after a successful check

### Multi-Provider Architecture
- Providers are independently configured with their own backends
- Models are fetched from all backends of a provider and **intersected** — only models present on every healthy backend are advertised
- Models are exposed as `providerId/modelName` (e.g., `openai/gpt-4`)
- Custom model aliases let clients use simple names instead of full provider paths

### Proxy Support
- SOCKS5 proxy connections are fully transparent to clients
- Each backend can use a different proxy
- Supports SOCKS5 authentication (username/password)
- Streaming works over SOCKS5 for both HTTP and HTTPS backends

### API Key Authentication
- Clients must provide `Authorization: Bearer <key>` header
- Keys are validated against `api-keys.json`
- Per-key `allowedModels` / `denyModels` control which models a key can access
- Missing or invalid keys receive 401/403 responses

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Server status |
| `GET` | `/_health` | Backend health status |
| `GET` | `/v1/models` | List available models (requires auth) |
| `POST` | `/v1/chat/completions` | Chat completions (requires auth) |
| `POST` | `/v1/completions` | Text completions (requires auth) |
| `POST` | `/v1/embeddings` | Embeddings (requires auth) |

## Building

Compile a standalone binary using Bun's built-in compiler:

```bash
# Build for all platforms (linux-x64, linux-x64-baseline, linux-arm64)
bun run compile

# Build for a specific platform
bun run compile -- --target linux-x64
bun run compile -- --target linux-arm64
```

The compiled binary is output to `build/bin/leiai-api-gateway-<platform>`.

## Testing

Comprehensive test suite covering all major functionality:

```bash
# Run all tests
bun test
```

Test files:

| File | Focus |
|---|---|
| `tests/smoke.test.ts` | 18 tests — basic imports and module functionality |
| `tests/unit.test.ts` | 27 tests — configuration parsing, algorithms, headers |
| `tests/integration.test.ts` | 22 tests — request forwarding, failover |
| `tests/socks5-streaming.test.ts` | 24 tests — SOCKS5 proxy and streaming |
| `tests/openai-integration.test.ts` | OpenAI-compatible endpoint testing |

Test coverage includes:
- ✅ Round-robin load distribution
- ✅ Health checks and automatic failover
- ✅ Request forwarding and header filtering
- ✅ Backend configuration (API keys, SOCKS5 proxies)
- ✅ Error handling and status codes
- ✅ URL construction and query parameters
- ✅ HTTP method support
- ✅ Streaming responses (direct and SOCKS5)
- ✅ SOCKS5 proxy support with streaming (HTTP & HTTPS)
- ✅ SOCKS5 authentication (username/password)
- ✅ Multiple proxies for different backends
- ✅ Server-Sent Events (SSE) over SOCKS5
- ✅ Chunked responses through proxies
- ✅ API key injection with SOCKS5
- ✅ OpenAI-compatible model listing and chat completions

```bash
# Type checking
bun run typecheck
```

## Deployment

### Docker (Multi-Stage)

The Dockerfile uses a two-stage build: compilation is done outside Docker, the runtime image is a minimal Debian slim base containing only the compiled binary:

```bash
# First compile the binary
bun run compile

# Then build the Docker image
docker build -f docker/Dockerfile -t leiai-api-gateway .

# Run the container
docker run -p 12117:12117 \
  -v $(pwd)/config/:/app/ \
  leiai-api-gateway
```

**Image**: ~100MB (Debian stable-slim + compiled binary)
**Port**: 12117
**User**: Non-root

### Docker Compose

```bash
# Start the gateway
docker compose -f docker/docker-compose.yml up

# Or in detached mode
docker compose -f docker/docker-compose.yml up -d
```

The compose file:
- Pulls the image from `gcr.leicraftmc.de/leicraftmc/leiai/api-gateway:latest`
- Maps port 12117
- Mounts config from `/opt/leiai/api-gateway/config.json`
- Includes health check (every 30s)

### Kubernetes

Create a ConfigMap with your `providers.json` and `api-keys.json`, then deploy:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: leiai-api-gateway
spec:
  replicas: 2
  selector:
    matchLabels:
      app: leiai-api-gateway
  template:
    metadata:
      labels:
        app: leiai-api-gateway
    spec:
      containers:
      - name: gateway
        image: gcr.leicraftmc.de/leicraftmc/leiai/api-gateway:latest
        ports:
        - containerPort: 12117
        env:
        - name: LAG_CONFIG_BASE_DIR
          value: /app
        volumeMounts:
        - name: config
          mountPath: /app
        livenessProbe:
          httpGet:
            path: /_health
            port: 12117
          initialDelaySeconds: 5
          periodSeconds: 30
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
      volumes:
      - name: config
        configMap:
          name: gateway-config
---
apiVersion: v1
kind: Service
metadata:
  name: leiai-api-gateway
spec:
  selector:
    app: leiai-api-gateway
  ports:
  - protocol: TCP
    port: 80
    targetPort: 12117
  type: LoadBalancer
```

### systemd

Create `/etc/systemd/system/leiai-api-gateway.service`:

```ini
[Unit]
Description=LeiAI API Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/leiai-api-gateway
ExecStart=/usr/local/bin/bun start
Restart=always
Environment=LAG_CONFIG_BASE_DIR=/etc/leiai/config

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable leiai-api-gateway
sudo systemctl start leiai-api-gateway
```

## Project Structure

```
├── src/
│   ├── index.ts               # Entry point — orchestration & graceful shutdown
│   ├── api/
│   │   ├── index.ts           # Hono app wrapper
│   │   ├── utils/apiVersionRouter.ts
│   │   └── versions/v1/
│   │       ├── index.ts       # Router setup, auth + routes
│   │       ├── auth.ts        # Bearer token auth middleware
│   │       └── routes/openai.ts  # OpenAI proxy routes
│   ├── loadBalancing/
│   │   ├── providerManager.ts     # Provider registry
│   │   ├── loadBalancer.ts        # Round-robin backend selection
│   │   ├── healthMonitor.ts       # Health tracking (exponential backoff)
│   │   ├── backendAPIClient.ts    # HTTP/S + SOCKS5 client
│   │   └── providerModelsIndex.ts # Model listing & intersection
│   └── utils/
│       ├── index.ts           # Helpers (random, sleep, URL parsing)
│       ├── logger.ts          # Leveled logger
│       ├── cron.ts            # Cron job scheduler
│       └── config/
│           ├── index.ts       # Env var loading
│           ├── gatewayConfig.ts    # providers.json schema (Zod)
│           └── apiKeysConfig.ts    # api-keys.json schema (Zod)
├── config/
│   ├── providers.json         # Provider/backend definitions
│   ├── api-keys.json          # Client API keys
│   ├── gateway.example.json   # Example provider config
│   └── apikeys.example.json   # Example API key config
├── docker/
│   ├── Dockerfile             # Multi-stage Docker build
│   └── docker-compose.yml     # Docker Compose config
├── scripts/
│   └── compile/               # Binary compilation scripts
├── tests/
│   ├── smoke.test.ts
│   ├── unit.test.ts
│   ├── integration.test.ts
│   ├── socks5-streaming.test.ts
│   ├── openai-integration.test.ts
│   └── helpers/
│       ├── fakeOpenAICompatibleAPI.ts
│       └── socks5server/
└── .gitlab-ci.yml             # GitLab CI pipeline
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) — fast JavaScript runtime, bundler, and test runner
- **Framework**: [Hono](https://hono.dev) — lightweight web framework
- **Validation**: [Zod](https://zod.dev) — schema validation
- **Proxy**: [socks](https://www.npmjs.com/package/socks) — SOCKS5 client
- **Scheduling**: [cron](https://www.npmjs.com/package/cron) — job scheduling
- **Language**: TypeScript (strict mode, ESNext)

## License

MIT
