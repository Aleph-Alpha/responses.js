import { trace } from "@opentelemetry/api";
import type { Response } from "openai/resources/responses/responses";
import { config } from "../../lib/config.js";

export class StreamingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamingError";
	}
}

export type IncompleteResponse = Omit<Response, "incomplete_details" | "output_text" | "parallel_tool_calls">;
export const SEQUENCE_NUMBER_PLACEHOLDER = -1;
export const tracer = trace.getTracer("responses.js.routes.responses");

/**
 * Langfuse reads this attribute before any gen_ai.* attribute to pick the
 * observation type. Each model call must be exactly one "generation" carrying
 * its usage; spans that only wrap model calls are "span" and carry no usage,
 * otherwise Langfuse adds the same tokens to the trace total more than once.
 */
export const LANGFUSE_OBSERVATION_TYPE = "langfuse.observation.type";

export const OTEL_GENAI_CAPTURE_TOOL_CONTENT = config.otelGenaiCaptureToolContent;
