import { API } from "./api";
import { ConfigHandler } from "./utils/config";
import { Logger } from "./utils/logger";
import { Utils } from "./utils";
import { ApiKeysConfig } from "./utils/config/apiKeysConfig";
import { GatewayConfig } from "./utils/config/gatewayConfig";
import { CronJobHandler } from "./utils/cron";
import { ProviderManager } from "./loadBalancing/providerManager";

export class Main {

    static async main() {

        process.once("SIGINT", (type) => Main.gracefulShutdown(type, 0));
        process.once("SIGTERM", (type) => Main.gracefulShutdown(type, 0));

        process.once("uncaughtException", Main.handleUncaughtException);
        process.once("unhandledRejection", Main.handleUnhandledRejection);

        const config = await ConfigHandler.loadConfig();

		const apiKeysConfig = await ApiKeysConfig.loadConfig(config.LAG_CONFIG_BASE_DIR ?? "./config");
		const gatewayConfig = await GatewayConfig.loadConfig(config.LAG_CONFIG_BASE_DIR ?? "./config");

        Logger.setLogLevel(config.LAG_LOG_LEVEL ?? "info");

        await Utils.ensureDirectoryExists(config.LAG_CONFIG_BASE_DIR ?? "./config");

		await ProviderManager.init(gatewayConfig.providers, true);


		await CronJobHandler.startAll();

        await API.init({
			host: config.LAG_HOST ?? "::",
			port: parseInt(config.LAG_PORT ?? "12117"),
		});

        await API.start();

    }

    private static async gracefulShutdown(type: NodeJS.Signals, code: number) {
        try {
            Logger.log(`Received ${type}, shutting down...`);

            await API.stop();
			await CronJobHandler.stopAll();

            Logger.log("Shutdown complete, exiting.");
            process.exit(code);
        } catch {
            Logger.critical("Error during shutdown, forcing exit");
            Main.forceShutdown();
        }
        }

    private static forceShutdown() {
        process.once("SIGTERM", ()=>{});
        process.exit(1);
    }

    private static async handleUncaughtException(error: Error) {
        Logger.critical(`Uncaught Exception:\n${Error.isError(error) ? error.stack ? error.stack : error.message : error}`);
        Main.gracefulShutdown("SIGTERM", 1);
    }

    private static async handleUnhandledRejection(reason: any) {
        if (Error.isError(reason)) {
            // reason is an error
            return Main.handleUncaughtException(reason);
        }
        Logger.critical(`Unhandled Rejection:\n${reason}`);
        Main.gracefulShutdown("SIGTERM", 1);
    }

}

Main.main()