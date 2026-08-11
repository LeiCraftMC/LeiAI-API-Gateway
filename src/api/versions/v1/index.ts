import { Hono } from "hono";
import { APIVersionRouter } from "../../utils/apiVersionRouter";
import { router as openaiRouter } from "./routes/openai";
import { router as anthropicRouter } from "./routes/anthropic";
import { router as responsesRouter } from "./routes/responses";
import { authMiddlewareV1 } from "./auth";

const router = new Hono();

// Apply auth middleware to all v1 routes
router.use("*", authMiddlewareV1);

// OpenAI-compatible endpoints (/v1/chat/completions, /v1/completions,
// /v1/embeddings, /v1/models), Anthropic-compatible endpoints
// (/v1/messages), and the OpenAI Responses endpoint (/v1/responses).  All
// are mounted under /v1 with no path overlap except /v1/models, which the
// OpenAI router serves in an auth-method-aware way (Anthropic envelope for
// x-api-key clients).
router.route("/", openaiRouter);
router.route("/", anthropicRouter);
router.route("/", responsesRouter);

export class APIv1Router extends APIVersionRouter {
	constructor() {
		super({
			version: 1,
			routes: router
		});
	}
}
