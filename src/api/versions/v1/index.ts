import { Hono } from "hono";
import { APIVersionRouter } from "../../utils/apiVersionRouter";
import { router as openaiRouter } from "./routes/openai";

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
