import { type Response as ExpressResponse } from "express";
import { context, propagation, SpanStatusCode, type Context, type Span } from "@opentelemetry/api";
import type { ValidatedRequest } from "../../middleware/validation.js";
import type { CreateResponseParams, McpServerParams } from "../../schemas.js";

// All headers are forwarded by default, except these ones.
export const NOT_FORWARDED_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"authorization",
	"connection",
	"content-length",
	"content-type",
	"host",
	"keep-alive",
	"te",
	"trailer",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

export const buildJsonAttribute = (value: unknown): string => {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

export const getRequestTraceContext = (req: ValidatedRequest<CreateResponseParams>): Context => {
	const carrier: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") {
			carrier[key] = value;
		} else if (Array.isArray(value)) {
			carrier[key] = value.join(",");
		}
	}

	return propagation.extract(context.active(), carrier);
};

export const recordError = (span: Span, error: unknown): void => {
	span.recordException(error instanceof Error ? error : new Error(String(error)));
	span.setStatus({
		code: SpanStatusCode.ERROR,
		message: error instanceof Error ? error.message : String(error),
	});
};

export function requiresApproval(toolName: string, mcpToolsMapping: Map<string, McpServerParams>): boolean {
	const toolParams = mcpToolsMapping.get(toolName);
	if (!toolParams) {
		return true; // default to requiring approval if tool not found
	}
	return toolParams.require_approval === "always"
		? true
		: toolParams.require_approval === "never"
			? false
			: toolParams.require_approval.always?.tool_names?.includes(toolName)
				? true
				: toolParams.require_approval.never?.tool_names?.includes(toolName)
					? false
					: true; // behavior is undefined in specs, let's default to true
}

export function writeWithBackpressure(res: ExpressResponse, data: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (res.destroyed || res.writableEnded) {
			reject(new Error("Response stream is no longer writable"));
			return;
		}

		let canContinue: boolean;
		try {
			canContinue = res.write(data);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (canContinue) {
			resolve();
			return;
		}

		const onDrain = (): void => {
			res.off("error", onError);
			resolve();
		};

		const onError = (err: Error): void => {
			res.off("drain", onDrain);
			reject(err);
		};

		res.once("drain", onDrain);
		res.once("error", onError);
	});
}
