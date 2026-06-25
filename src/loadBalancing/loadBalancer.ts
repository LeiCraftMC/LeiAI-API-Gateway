import { BackendAPIClient } from "./backendAPIClient"
import { HealthMonitor } from "./healthMonitor"
import { Logger } from "../utils/logger";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Build a backend-relative path by stripping the provider prefix. */
function stripPrefix(pathname: string, prefix: string): string {
	const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
	if (normalizedPrefix === "/") return pathname;
	return pathname.startsWith(`${normalizedPrefix}/`)
		? pathname.slice(normalizedPrefix.length)
		: pathname === normalizedPrefix
			? "/"
			: pathname;
}

/** Headers that MUST NOT be forwarded to the backend. */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
]);

/* ------------------------------------------------------------------ */
/*  Interfaces                                                         */
/* ------------------------------------------------------------------ */

export interface LoadBalancerBackend {
	name: string;
	apiClient: BackendAPIClient;
}

/* ------------------------------------------------------------------ */
/*  LoadBalancer  —  Round-robin + health-aware request forwarding      */
/* ------------------------------------------------------------------ */

export class LoadBalancer {
	private currentIndex = 0;

	constructor(
		private readonly providerId: string,
		private readonly prefix: string,
		private readonly backends: LoadBalancerBackend[],
		private readonly healthMonitor: HealthMonitor,
	) {}

	// ---- Backend selection --------------------------------------------

	/**
	 * Get the index of the next healthy backend (round-robin).
	 * Falls back to all backends when none are healthy.
	 * Returns `null` when the backend list is empty.
	 */
	getNextBackendIndex(): number | null {
		const healthyIndices = this.backends
			.map((_, i) => i)
			.filter((i) => this.healthMonitor.isHealthy(i));

		const pool = healthyIndices.length > 0
			? healthyIndices
			: this.backends.map((_, i) => i);

		if (pool.length === 0) return null;

		if (healthyIndices.length === 0) {
			Logger.warn(
				`Provider "${this.providerId}": no healthy backends, falling back to all backends`,
			);
		}

		const index = pool[this.currentIndex % pool.length]!;
		this.currentIndex = (this.currentIndex + 1) % pool.length;
		return index;
	}

	/** Return all backends. */
	getAllBackends(): LoadBalancerBackend[] {
		return this.backends;
	}

	// ---- Request forwarding -------------------------------------------

	/**
	 * Forward a request to the next healthy backend.
	 * Marks the backend unhealthy on error or non-2xx response.
	 */
	async forwardRequest(
		pathname: string,
		searchParams: string,
		method: string,
		headers: Headers,
		body?: string,
	): Promise<Response> {
		const backendIndex = this.getNextBackendIndex();
		if (backendIndex === null) {
			return new Response(
				JSON.stringify({
					error: { message: "No backends available", type: "server_error" },
				}),
				{ status: 503, headers: { "Content-Type": "application/json" } },
			);
		}

		const backend = this.backends[backendIndex]!;
		const backendPath = stripPrefix(pathname, this.prefix);
		const forwardHeaders = this.buildForwardHeaders(headers);

		try {
			const response = await backend.apiClient.request(backendPath + searchParams, {
				method,
				headers: forwardHeaders,
				body,
			});

			if (!response.ok) {
				this.healthMonitor.setHealthyness(backendIndex, false);
				const errorBody = await response.text().catch(() => "<unreadable body>");
				Logger.error(
					`Provider "${this.providerId}" backend "${backend.name}" returned error: ` +
					`status=${response.status}, body=${errorBody.slice(0, 500)}`,
				);
			}

			return this.wrapResponse(response, backend.name);
		} catch (error) {
			this.healthMonitor.setHealthyness(backendIndex, false);
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(
				`Provider "${this.providerId}" backend "${backend.name}" request failed: ${message}`,
			);
			return new Response(
				JSON.stringify({
					error: { message: "Bad Gateway", type: "server_error" },
				}),
				{ status: 502, headers: { "Content-Type": "application/json" } },
			);
		}
	}

	// ---- Internals ----------------------------------------------------

	private wrapResponse(response: Response, backendName: string): Response {
		const headers = new Headers(response.headers);
		headers.set("X-Load-Balancer-Backend", backendName);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private buildForwardHeaders(headers: Headers): Headers {
		const forwardHeaders = new Headers();
		headers.forEach((value, key) => {
			if (!HOP_BY_HOP.has(key.toLowerCase())) {
				forwardHeaders.set(key, value);
			}
		});
		return forwardHeaders;
	}
}
