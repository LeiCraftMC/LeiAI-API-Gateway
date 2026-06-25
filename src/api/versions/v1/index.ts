import { Hono } from "hono";
import { APIVersionRouter } from "../../utils/apiVersionRouter";
import { router as openaiRouter } from "./routes/openai";
import { ApiKeysConfig } from "../../../utils/config/apiKeysConfig";
import { Logger } from "../../../utils/logger";

const router = new Hono();




router.route("/", openaiRouter);

export class APIv1Router extends APIVersionRouter {
    constructor() {
        super({
            version: 1,
            routes: router
        });
    }
}
