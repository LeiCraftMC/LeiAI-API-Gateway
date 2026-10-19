import z from "zod";

export class GatewayConfig {

	private static config: GatewayConfig.Types.ConfigSchema | null = null;

	static getConfig() {
		return this.config;
	}

	static async loadConfig(confifBaseDir: string): Promise<GatewayConfig.Types.ConfigSchema> {
		if (this.config) return this.config;
		
		try {
			const raw_config = await Bun.file(`${confifBaseDir}/gateway.json`).json();
			this.config = GatewayConfig.Types.ConfigSchema.parse(raw_config);
			

		} catch (error) {
			throw new Error(`Failed to load gateway configuration: ${error}`);
		}

		return this.config;
	}

}

export namespace GatewayConfig.Types {

	export const ProviderBackend = z.object({
		name: z.string().min(1, "Backend name cannot be empty"),
		baseUrl: z.string().url("Backend URL must be a valid URL"),
		apiKey: z.string().optional(),
		proxyUrl: z.string().url("Proxy URL must be a valid URL").optional(),
	});
	export type ProviderBackend = z.infer<typeof ProviderBackend>;


	export const Provider = z.object({
		id: z.string().min(1, "Provider ID cannot be empty").regex(/^[a-z0-9-]+$/, "Provider ID can only be lowercase letters, numbers, and hyphens"),
		name: z.string().min(1, "Provider name cannot be empty"),
		backends: z.array(ProviderBackend),
		/**
		 * Whether the backends of this provider accept native Anthropic-style
		 * `POST /v1/messages` requests (authenticated with `x-api-key` +
		 * `anthropic-version`).
		 *
		 * - `false` (default): a client request to the gateway's
		 *   `/v1/messages` endpoint is translated into a chat-completions
		 *   request before forwarding.
		 *
		 * - `true`: the backend accepts Anthropic messages directly, so a
		 *   `/v1/messages` request is forwarded as-is (passthrough) using
		 *   Anthropic-style authentication.
		 *
		 * Must be `true` when `supportsOpenAILikeAPI` is `false`.
		 */
		supportsAnthropicLikeAPI: z.boolean().default(false),
		/**
		 * Whether the backends of this provider speak the OpenAI API
		 * (`/chat/completions`, `/completions`, `/embeddings`, `/models`).
		 *
		 * - `true` (default): OpenAI-style client requests are forwarded
		 *   as-is, and `/v1/responses` is translated to chat-completions.
		 *
		 * - `false`: the backends only speak the Anthropic Messages API
		 *   (requires `supportsAnthropicLikeAPI: true`).  `/v1/chat/completions`
		 *   and `/v1/responses` requests are translated to `/messages`, models
		 *   are listed via the Anthropic `/models` endpoint, and
		 *   `/v1/completions` / `/v1/embeddings` are rejected because
		 *   Anthropic has no equivalent.
		 */
		supportsOpenAILikeAPI: z.boolean().default(true),
	}).refine(
		(provider) => provider.supportsOpenAILikeAPI || provider.supportsAnthropicLikeAPI,
		{
			message: "A provider must support at least one API: set supportsAnthropicLikeAPI to true when supportsOpenAILikeAPI is false",
			path: ["supportsAnthropicLikeAPI"],
		},
	);
	export type Provider = z.infer<typeof Provider>;

	/**
	 * The *input* shape of {@link Provider} — identical except that fields
	 * with a zod `.default()` (like `supportsAnthropicLikeAPI` and
	 * `supportsOpenAILikeAPI`) are optional.
	 * Used for APIs that accept provider configs the caller constructs
	 * directly (tests, {@link ProviderManager.init}) so callers don't have
	 * to spell out the defaulted fields.
	 */
	export type ProviderInput = z.input<typeof Provider>;


	export const ConfigSchema = z.object({

		providers: z.array(Provider)
			.refine((providers) => {

				const providerIds = new Set<string>();
				for (const provider of providers) {
					if (providerIds.has(provider.id)) {
						return false; // Duplicate provider ID found
					}
					providerIds.add(provider.id);
				}
				return true;
			}, { message: "Provider IDs must be unique" }
		),

		customModels: z.object({

			mapping: z.record(
				z.string().meta({ description: "Model Alias" }),
				z.union([
					z.string().meta({ description: "Real Model (provider/model)" }),
					z.object({
						target: z.string().meta({ description: "Real Model (provider/model)" }),
						aliases: z.array(z.string()).meta({ description: "Additional Model Aliases for invisible on /v1/models endpoint" }),
					})
					.meta({ description: "Mapping with More Config Options" })
				])
			),

			ownerID: z.string()
				.regex(/^[a-zA-Z0-9-_]+$/, "Custom model owner key can only contain letters, numbers, hyphens and underscores")
				.meta({ description: "Custom model owner ID for the /v1/models endpoint" })
		}).optional()
	});

	export type ConfigSchema = z.infer<typeof ConfigSchema>;

}

