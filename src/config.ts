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

export interface Config {
  port: number;
  host: string;
  backends: Backend[];
  healthCheckInterval?: number;
}

export async function loadConfig(filePath: string): Promise<Config> {
  const configText = await Bun.file(filePath).text();
  const config: Config = JSON.parse(configText);

  if (!config.port) config.port = 3000;
  if (!config.host) config.host = "0.0.0.0";
  if (!config.healthCheckInterval) config.healthCheckInterval = 30000;

  if (!config.backends || config.backends.length === 0) {
    throw new Error("At least one backend must be configured");
  }

  return config;
}
