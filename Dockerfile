FROM oven/bun:latest as builder

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --production

# Copy source code
COPY src ./src
COPY tsconfig.json .

# Compile to standalone executable
RUN bun compile ./src/index.ts --outfile /app/load-balancer

# Runtime stage - minimal base image
FROM debian:bookworm-slim

WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy config
COPY config.json .

# Copy only the compiled executable from builder
COPY --from=builder /app/load-balancer /app/load-balancer

# Make executable
RUN chmod +x /app/load-balancer

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/_health || exit 1

# Non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 3000

# Run the compiled executable
CMD ["/app/load-balancer"]


