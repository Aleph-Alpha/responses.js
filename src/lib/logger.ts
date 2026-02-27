import pino from "pino";
import pinoHttp from "pino-http";
import { generateUniqueId } from "./generateUniqueId.js";
import type { IncomingMessage } from "http";

const headerValue = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value;

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const LOG_PRETTY = process.env.LOG_PRETTY === "true";

export const logger = pino({
	level: LOG_LEVEL,
	timestamp: pino.stdTimeFunctions.isoTime,
	redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]'],
	...(LOG_PRETTY
		? {
				transport: {
					target: "pino-pretty",
				},
			}
		: {}),
});

export const httpLogger = pinoHttp({
	logger,
	genReqId: (req: IncomingMessage) => {
		return (
			headerValue(req.headers["x-request-id"]) ?? headerValue(req.headers["x-trace-id"]) ?? generateUniqueId("req")
		);
	},
	customProps: (req: IncomingMessage) => ({
		trace_id: headerValue(req.headers["x-trace-id"]) ?? headerValue(req.headers["x-request-id"]),
		session_id: headerValue(req.headers["x-session-id"]),
	}),
	customLogLevel: (_req: IncomingMessage, res: { statusCode: number }) => {
		if (res.statusCode >= 500) return "error";
		if (res.statusCode >= 400) return "warn";
		return "info";
	},
	autoLogging: {
		ignore: (req: IncomingMessage) => req.url === "/health",
	},
});
