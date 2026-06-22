export interface SocksProxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface Backend {
  name: string;
  url: string;
  apiKey?: string;
  proxy?: SocksProxy;
  healthCheckPath?: string;
  healthCheckInterval?: number;
}

export interface ProviderConfig {
  name: string;
  /** Route prefix, e.g. "/my-provider". Defaults to "/<name>". */
  prefix?: string;
  backends: Backend[];
}

export interface Config {
  port: number;
  host: string;
  providers: ProviderConfig[];
  healthCheckInterval?: number;
}

function setDefaults(config: Config): Config {
  if (!config.port) config.port = 3000;
  if (!config.host) config.host = "0.0.0.0";
  if (!config.healthCheckInterval) config.healthCheckInterval = 30000;
  return config;
}

function validateProvider(provider: ProviderConfig, index: number): void {
  if (!provider.name || typeof provider.name !== "string") {
    throw new Error(`Provider at index ${index} must have a non-empty name`);
  }

  const prefix = provider.prefix || `/${provider.name}`;
  if (!prefix.startsWith("/")) {
    throw new Error(
      `Provider "${provider.name}" prefix "${prefix}" must start with "/"`
    );
  }

  if (!provider.backends || provider.backends.length === 0) {
    throw new Error(
      `Provider "${provider.name}" must have at least one backend`
    );
  }

  for (const backend of provider.backends) {
    if (!backend.name || typeof backend.name !== "string") {
      throw new Error(
        `Provider "${provider.name}" has a backend without a name`
      );
    }
    if (!backend.url || typeof backend.url !== "string") {
      throw new Error(
        `Provider "${provider.name}" backend "${backend.name}" is missing a valid url`
      );
    }
  }
}

export async function loadConfig(filePath: string): Promise<Config> {
  const configText = await Bun.file(filePath).text();
  const config: Config = JSON.parse(configText);

  setDefaults(config);

  if (!config.providers || config.providers.length === 0) {
    throw new Error("At least one provider must be configured");
  }

  config.providers.forEach((provider, index) => validateProvider(provider, index));

  return config;
}
