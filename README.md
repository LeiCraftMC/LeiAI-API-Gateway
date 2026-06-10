# AI API Load Balancer

A high-performance OpenAI-compatible API load balancer built with Bun. Distributes requests across multiple LLM backends with round-robin routing, health checks, and optional SOCKS5 proxy support.

## Features

- **Round-robin load balancing**: Automatically distributes requests across healthy backends
- **Full streaming support**: OpenAI streaming completions, SSE, and any streaming protocol
- **Health checks**: Continuous monitoring of backend availability with automatic failover
- **API key management**: Configure API keys per backend
- **SOCKS5 proxy support**: Route backend requests through SOCKS5 proxies (including streaming)
- **OpenAI compatible**: Works as a drop-in replacement for OpenAI API endpoints
- **Health monitoring**: Built-in `/_health` endpoint to check backend status
- **JSON configuration**: Simple configuration format for backends

## Installation

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
```

## Configuration

Edit `config.json` to configure your backends:

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "healthCheckInterval": 30000,
  "backends": [
    {
      "name": "OpenAI Official",
      "url": "https://api.openai.com",
      "apiKey": "sk-your-key",
      "healthCheckPath": "/v1/models",
      "healthCheckInterval": 30000
    },
    {
      "name": "Local LLM",
      "url": "http://localhost:8000",
      "healthCheckPath": "/v1/models"
    },
    {
      "name": "Remote LLM via SOCKS5",
      "url": "http://remote-server.com:8000",
      "apiKey": "your-key",
      "proxy": {
        "host": "proxy.example.com",
        "port": 1080,
        "username": "user",
        "password": "pass"
      }
    }
  ]
}
```

### Configuration Options

- **port**: Server port (default: 3000)
- **host**: Server host (default: 0.0.0.0)
- **healthCheckInterval**: Global health check interval in ms (default: 30000)
- **backends**: Array of backend configurations

### Backend Options

- **name**: Unique identifier for the backend
- **url**: Full URL to the OpenAI-compatible backend
- **apiKey**: (optional) API key for the backend
- **proxy**: (optional) SOCKS5 proxy configuration
  - **host**: Proxy server hostname
  - **port**: Proxy server port
  - **username**: (optional) Proxy authentication username
  - **password**: (optional) Proxy authentication password
- **healthCheckPath**: (optional) Endpoint to health check (default: /v1/models)
- **healthCheckInterval**: (optional) Per-backend health check interval in ms

## Usage

### Start the server

```bash
# Development with hot reload
bun run dev

# Production
bun start

# With custom config
CONFIG_PATH=/path/to/config.json bun start
```

### Using the load balancer

Once running, use it like you would use the OpenAI API:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming responses

Streaming fully works with both direct and SOCKS5 proxy backends:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

Works with any streaming protocol:
- OpenAI streaming completions (SSE)
- Server-Sent Events (SSE)
- Any chunked transfer encoding
- WebSocket upgrades (pass-through)

### Health check

Check the status of all backends:

```bash
curl http://localhost:3000/_health
```

Response:
```json
{
  "status": "healthy",
  "backends": [
    {
      "name": "OpenAI Official",
      "healthy": true,
      "lastCheck": "2024-01-15T10:30:45.123Z",
      "consecutiveFailures": 0
    }
  ]
}
```

## How It Works

### Load Balancing
- Uses round-robin to distribute requests across healthy backends
- Automatically skips unhealthy backends
- Falls back to any available backend if all are unhealthy

### Health Checks
- Periodically checks backend availability (default: every 30 seconds)
- Marks backend unhealthy after 3 consecutive failures
- Recovers backend after successful check
- Health status includes last check time and failure count

### Proxy Support
- Connections through SOCKS5 proxies are fully transparent to clients
- Each backend can use a different proxy
- Credentials are supported for SOCKS5 authentication

### API Key Management
- API keys are injected into backend requests automatically
- Clients don't need to specify keys; the load balancer handles it
- Optional per-backend keys

## Building

```bash
bun run build
```

Outputs to `dist/index.js`

## Testing

Comprehensive test suite with **91 tests** covering all major functionality:

```bash
# Run all tests
bun test

# Run specific test suites
bun test:smoke       # 18 smoke tests - basic imports and functionality
bun test:unit        # 27 unit tests - configuration, algorithms, headers
bun test:integration # 22 integration tests - request forwarding, failover
bun test:socks5      # 24 SOCKS5 streaming tests - proxy and streaming
```

Test coverage includes:
- ✅ Round-robin load distribution
- ✅ Health checks and automatic failover
- ✅ Request forwarding and header filtering
- ✅ Backend configuration (API keys, SOCKS5 proxies)
- ✅ Error handling and status codes
- ✅ URL construction and query parameters
- ✅ HTTP method support
- ✅ **Streaming responses** (direct and SOCKS5)
- ✅ **SOCKS5 proxy support** with streaming (HTTP & HTTPS)
- ✅ **Multiple proxies** for different backends
- ✅ **Server-Sent Events** (SSE) over SOCKS5
- ✅ **Chunked responses** through proxies
- ✅ **API key injection** with SOCKS5
- ✅ **SOCKS5 authentication** (username/password)

Example output:
```
 91 pass
 0 fail
 200 expect() calls
Ran 91 tests across 4 files
```

## Deployment

### Docker

Create a `Dockerfile`:

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "start"]
```

Build and run:

```bash
docker build -t ai-load-balancer .
docker run -p 3000:3000 -v $(pwd)/config.json:/app/config.json ai-load-balancer
```

### systemd

Create `/etc/systemd/system/ai-load-balancer.service`:

```ini
[Unit]
Description=AI Load Balancer
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-load-balancer
ExecStart=/usr/local/bin/bun start
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable ai-load-balancer
sudo systemctl start ai-load-balancer
```

## License

MIT
