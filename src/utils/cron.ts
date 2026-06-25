import { CronJob } from "cron";
import { ProviderManager } from "../loadBalancing/providerManager";

export class CronJobHandler {

    private static jobs: CronJob[] = [];
    private static initialized: boolean = false;

    static async init() {
        if (this.initialized) return;
        this.initialized = true;

        this.jobs.push(new CronJob('*/5 * * * *', async () => {
            await ProviderManager.refreshHealthMonitorData();
        }));

        this.jobs.push(new CronJob('*/5 * * * *', async () => {
            await ProviderManager.refreshModelsData();
        }));

    }

    static async startAll() {
        if (!this.initialized) {
            await this.init();
        }
        for (const job of this.jobs) {
            job.start();
        }
    }

    static async stopAll() {
        for (const job of this.jobs) {
            await job.stop();
        }
    }

}