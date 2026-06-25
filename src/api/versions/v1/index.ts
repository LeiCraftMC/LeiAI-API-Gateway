import { Hono } from "hono";
import { APIVersionRouter } from "../../utils/apiVersionRouter";
import { router as openaiRouter } from "./routes/openai";
import { authMiddlewareV1 } from "./auth";

const router = new Hono();

// Apply auth middleware to all v1 routes
router.use("*", authMiddlewareV1);

router.route("/", openaiRouter);

export class APIv1Router extends APIVersionRouter {
	constructor() {
		super({
			version: 1,
			routes: router
		});
	}
}
