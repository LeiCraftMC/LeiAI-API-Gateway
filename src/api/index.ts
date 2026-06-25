import { Hono } from "hono";
import { Logger } from "../utils/logger";
import { APIv1Router } from "./versions/v1";
import type { APIVersionRouter } from "./utils/apiVersionRouter";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface APIDependencies {
    port: number;
    host: string;
}

/* ------------------------------------------------------------------ */
/*  API  —  Hono-powered HTTP front-end for the load balancer          */
/* ------------------------------------------------------------------ */

export class API {

    private static server: Bun.Server<undefined>;
    private static app: Hono;

    private static _initialized = false;
    private static deps: APIDependencies;

    protected static latestVersion: number | null = null;

    protected static registerVersion(versionRouter: APIVersionRouter) {

        this.app.route(`/v${versionRouter.version}`, versionRouter.router);

        if (!this.latestVersion || versionRouter.version > this.latestVersion) {
            this.latestVersion = versionRouter.version;
        }
    }


    static async init(deps: APIDependencies) {
        if (this._initialized) {
            throw new Error("API is already initialized.");
        }
        this._initialized = true;

        this.deps = deps;
        this.app = new Hono();

        this.app.onError((err, c) => {
            Logger.error("API Error:", err);
            return c.json(
                { success: false, code: 500, message: "Internal Server Error" },
                500,
            );
        });

        this.registerVersion(new APIv1Router);

        this.app.get("/health", (c) => {
            return c.json({
                success: true,
                code: 200,
                message: "LeiAI API Gateway is running",
                data: null,
            });
        });


        this.app.get("/", (c) => {
            return c.json({
                success: true,
                code: 200,
                message: "LeiAI API Gateway is running",
                data: null,
            });
        });

    }

    static async start() {

        if (!this._initialized) {
            throw new Error("API not initialized. Call API.init() first.");
        }

        this.server = Bun.serve({ port: this.deps.port, hostname: this.deps.host, fetch: this.app.fetch });

        Logger.log(`API is running at ${this.server?.hostname}:${this.server?.port}`);
    }

    static async stop() {
        if (this.server) {
            this.server.stop();
            Logger.log("API server stopped.");
        }
    }

    static getApp(): typeof API.app {
        if (!this.app) {
            throw new Error("API not initialized. Call API.init() first.");
        }
        return this.app;
    }

}
