import type { LLMOutputEvent } from "./llmEvents.js";
import type { Logger } from "pino";

/**
 * Parse a native Responses API streaming response into backend-agnostic LLMOutputEvents.
 * This is a stub for Phase 2 — it will be implemented when the inference layer
 * provides a native Responses API.
 */
// eslint-disable-next-line require-yield
export async function* parseResponsesApiStream(
	// eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
	_stream: AsyncIterable<unknown>,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
	_log: Logger
): AsyncGenerator<LLMOutputEvent> {
	throw new Error("responsesApiParser: not yet implemented. BACKEND_MODE=responses_api is not supported yet.");
}
