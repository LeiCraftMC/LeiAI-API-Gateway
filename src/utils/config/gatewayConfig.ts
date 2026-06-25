import z from "zod";

export class GatewayConfig {

	private static config: GatewayConfig.Types.ConfigSchema | null = null;

	static getConfig() {
		return this.config;
	}

	static async loadConfig(confifBaseDir: string): Promise<GatewayConfig.Types.ConfigSchema> {
		if (this.config) return this.config;
		
		try {
			const raw_config = await Bun.file(`${confifBaseDir}/providers.json`).json();
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
	});
	export type Provider = z.infer<typeof Provider>;


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

		modelsMap: z.record(
			z.string().meta({ description: "Model Alias" }),
			z.string().meta({ description: "Read Model (provider/model)" })
		).optional(),
	});

	export type ConfigSchema = z.infer<typeof ConfigSchema>;

}

