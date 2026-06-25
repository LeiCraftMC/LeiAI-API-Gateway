import z from "zod";

export class ApiKeysConfig {

    private static config: ApiKeysConfig.Types.ConfigSchema | null = null;

    static getConfig() {
        return this.config;
    }

    static async loadConfig(confifBaseDir: string): Promise<ApiKeysConfig.Types.ConfigSchema> {
        if (this.config) return this.config;

        try {
            const raw_config = await Bun.file(`${confifBaseDir}/api-keys.json`).json();
            this.config = ApiKeysConfig.Types.ConfigSchema.parse(raw_config);


        } catch (error) {
            throw new Error(`Failed to load API keys configuration: ${error}`);
        }

        return this.config;
    }

}

export namespace ApiKeysConfig.Types {

    export const ConfigSchema = z.record(
        z.string().min(1, "API key cannot be empty").regex(/^[a-zA-Z0-9-_]+$/, "API key can only contain letters, numbers, hyphens, and underscores"),
        z.object({
            description: z.string().optional(),
            allowedModels: z.array(z.string()).optional().meta({ description: "List of allowed model names for this API key, if empty all models are allowed" }),
            denyModels: z.array(z.string()).optional().meta({ description: "List of denied model names for this API key, if empty no models are denied" }),
        }).refine((obj) => {
            if (obj.allowedModels && obj.denyModels) {
                return false; // Both allowedModels and denyModels are defined, which is not allowed
            }
            return true;
        }, "API key cannot have both allowedModels and denyModels defined")
    );

    export type ConfigSchema = z.infer<typeof ConfigSchema>;

}