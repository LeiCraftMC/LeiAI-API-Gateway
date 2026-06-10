import type { Backend } from "./config";
import { isHealthy } from "./healthCheck";
import { createHttpClient } from "./httpClient";

export class LoadBalancer {
  private backends: Backend[];
  private currentIndex: number = 0;

  constructor(backends: Backend[]) {
    this.backends = backends;
  }

  getNextBackend(): Backend | null {
    const healthyBackends = this.backends.filter((b) => isHealthy(b.name));

    if (healthyBackends.length === 0) {
      console.warn("No healthy backends available, falling back to all backends");
      if (this.backends.length === 0) return null;
      this.currentIndex = (this.currentIndex + 1) % this.backends.length;
      return this.backends[this.currentIndex - 1];
    }

    this.currentIndex = (this.currentIndex + 1) % healthyBackends.length;
    return healthyBackends[this.currentIndex - 1];
  }

  getAllBackends(): Backend[] {
    return this.backends;
  }

  async forwardRequest(
    pathname: string,
    searchParams: string,
    method: string,
    headers: Headers,
    body?: string
  ): Promise<Response> {
    const backend = this.getNextBackend();

    if (!backend) {
      return new Response(JSON.stringify({ error: "No backends available" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const backendUrl = new URL(
      pathname + searchParams,
      backend.url
    ).toString();

    // Copy relevant headers, excluding hop-by-hop headers
    const forwardHeaders = new Headers();
    headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (
        !["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(
          lowerKey
        )
      ) {
        forwardHeaders.set(key, value);
      }
    });

    // Remove host header to let the backend set it
    forwardHeaders.delete("host");

    const client = createHttpClient(backend);

    try {
      const backendResponse = await client.request(backendUrl, {
        method,
        headers: forwardHeaders,
        body,
      });

      // Response object from streaming-capable client
      if (backendResponse instanceof Response) {
        const newHeaders = new Headers(backendResponse.headers);
        newHeaders.set("X-Load-Balancer-Backend", backend.name);
        return new Response(backendResponse.body, {
          status: backendResponse.status,
          statusText: backendResponse.statusText,
          headers: newHeaders,
        });
      }

      // Fallback for non-streaming responses
      return new Response(backendResponse.body, {
        status: backendResponse.status,
        headers: {
          "Content-Type": backendResponse.headers.get("Content-Type") || "application/json",
          "X-Load-Balancer-Backend": backend.name,
        },
      });
    } catch (error) {
      console.error(`Error forwarding to ${backend.name}:`, error);
      return new Response(
        JSON.stringify({
          error: "Backend request failed",
          details: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }
}
