/**
 * Backend-agnostic intermediate events emitted by LLM stream parsers.
 * These decouple stream parsing (Chat Completions, future native Responses API)
 * from Responses API event construction.
 */
export type LLMOutputEvent =
	| { type: "text_delta"; content: string }
	| { type: "reasoning_delta"; content: string }
	| { type: "tool_call_start"; toolCallId: string; name: string }
	| { type: "tool_call_args_delta"; content: string }
	| UsageEvent;

/**
 * Token usage of one backend call. `reasoningTokens` is part of `outputTokens`
 * and is set only when the backend reports it.
 */
export interface UsageEvent {
	type: "usage";
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	reasoningTokens?: number;
}
