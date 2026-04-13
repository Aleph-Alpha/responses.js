import express, { type Express } from "express";
import { httpLogger } from "./lib/logger.js";
import { getLandingPageHtml, postCreateResponse, getHealth } from "./routes/index.js";

export const createApp = (): Express => {
	const app: Express = express();

	// Middleware
	app.use(httpLogger);

	// Routes
	app.get("/", getLandingPageHtml);

	app.get("/health", getHealth);

	// No body parser — the request body is streamed to the worker thread in chunks
	// to avoid buffering large payloads on the main event loop.
	app.post("/v1/responses", postCreateResponse);

	return app;
};
