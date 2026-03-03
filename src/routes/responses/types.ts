import { trace } from "@opentelemetry/api";
import type { Response } from "openai/resources/responses/responses";

export class StreamingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamingError";
	}
}

export type IncompleteResponse = Omit<Response, "incomplete_details" | "output_text" | "parallel_tool_calls">;
export const SEQUENCE_NUMBER_PLACEHOLDER = -1;
export const tracer = trace.getTracer("responses.js.routes.responses");

export const OTEL_GENAI_CAPTURE_TOOL_CONTENT =
	process.env.OTEL_GENAI_CAPTURE_TOOL_CONTENT === "1" ||
	process.env.OTEL_GENAI_CAPTURE_TOOL_CONTENT?.toLowerCase() === "true";
