import type { LLMOutputEvent } from "./llmEvents.js";
import type { Logger } from "pino";

/**
 * Parse a native Responses API streaming response into backend-agnostic LLMOutputEvents.
 * This is a stub for Phase 2 — it will be implemented when the inference layer
 * provides a native Responses API.
 */
export async function* parseResponsesApiStream(
	_stream: AsyncIterable<unknown>,
	_log: Logger
): AsyncGenerator<LLMOutputEvent> {
	throw new Error("responsesApiParser: not yet implemented. BACKEND_MODE=responses_api is not supported yet.");
}
