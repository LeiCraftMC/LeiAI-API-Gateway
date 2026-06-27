import { BackendAPIClient } from "./backendAPIClient"
import { HealthMonitor } from "./healthMonitor"
import { Logger } from "../utils/logger";


/* ------------------------------------------------------------------ */
/*  LoadBalancer  —  Round-robin + health-aware request forwarding      */
/* ------------------------------------------------------------------ */

export class LoadBalancer {
	private currentIndex = 0;

	constructor(
		private readonly providerId: string,
		private readonly backends: LoadBalancer.Backend[],
		private readonly healthMonitor: HealthMonitor,
	) {}

	// ---- Backend selection --------------------------------------------

	/**
	 * Get the index of the next healthy backend (round-robin).
	 * Falls back to all backends when none are healthy.
	 * Returns `null` when the backend list is empty.
	 */
	public getNextBackendIndex(): number | null {
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


	public getAllBackends(): LoadBalancer.Backend[] {
		return this.backends;
	}


	/**
	 * Forward a request to the next healthy backend.
	 * Marks the backend unhealthy on error or non-2xx response.
	 */
	async forwardRequest(
		pathname: string,
		method: string,
		headers?: RequestInit["headers"],
		body?: string,
	): Promise<LoadBalancer.ForwardingSuccess | LoadBalancer.ForwardingError> {

		const backendIndex = this.getNextBackendIndex();
		if (backendIndex === null) {
			return {
				response: null,
				error: {
					message: "No backends available",
					status: 503,
				},
			};
		}

		const backend = this.backends[backendIndex]!;

		try {
			const response = await backend.apiClient.request(pathname, {
				method,
				headers,
				body,
			});

			if (!response.ok) {

				this.healthMonitor.setHealthyness(backendIndex, false);

				const errorBody = await response.text().catch(() => "<unreadable body>");
				Logger.error(
					`Provider "${this.providerId}" backend "${backend.name}" returned error: ` +
					`status=${response.status}, body=${errorBody.slice(0, 500)}`,
				);

				return {
					response: null,
					error: {
						message: "Backend returned error: " + errorBody.slice(0, 500),
						status: response.status,
					},
				};
			}

			return {
				response: new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				}),
				error: null
			}

		} catch (error) {

			this.healthMonitor.setHealthyness(backendIndex, false);

			const message = error instanceof Error ? error.message : String(error);
			Logger.error(
				`Provider "${this.providerId}" backend "${backend.name}" request failed: ${message}, Stack: ${error instanceof Error ? error.stack : "<no stack>"}`
			);
			return {
				response: null,
				error: {
					status: 502,
					message: "Bad Gateway",
				}
			}
		}
	}

}

export namespace LoadBalancer {

	export interface Backend {
		name: string;
		apiClient: BackendAPIClient;
	}

	export type ForwardingResult = ForwardingSuccess | ForwardingError;

	export interface ForwardingSuccess {
		response: Response;
		error: null;
	}

	export interface ForwardingError {
		response: null | Response;
		error: {
			status: number;
			message: string;
		};
	}

}
