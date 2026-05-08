import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { PatchedDeltaWithReasoning } from "../../openai_patch";
import type { LLMOutputEvent } from "./llmEvents.js";
import type { Logger } from "pino";

/**
 * Parse a Chat Completions streaming response into backend-agnostic LLMOutputEvents.
 * This function has NO knowledge of responseObject, MCP, or Responses API SSE events.
 * It is the only module that changes when switching LLM backends.
 */
export async function* parseChatCompletionsStream(
	stream: AsyncIterable<ChatCompletionChunk>,
	log: Logger
): AsyncGenerator<LLMOutputEvent> {
	for await (const chunk of stream) {
		if (chunk.usage) {
			yield {
				type: "usage",
				inputTokens: chunk.usage.prompt_tokens,
				outputTokens: chunk.usage.completion_tokens,
				totalTokens: chunk.usage.total_tokens,
			};
		}

		if (!chunk.choices[0]) {
			continue;
		}

		const delta = chunk.choices[0].delta as PatchedDeltaWithReasoning;
		const reasoningText = delta.reasoning ?? delta.reasoning_content;

		if (delta.content || reasoningText) {
			if (reasoningText) {
				yield { type: "reasoning_delta", content: reasoningText as string };
			} else if (delta.content) {
				yield { type: "text_delta", content: delta.content as string };
			}
		} else if (delta.tool_calls && delta.tool_calls.length > 0) {
			if (delta.tool_calls.length > 1) {
				log.warn("Multiple tool calls not supported, only the first will be processed");
			}

			if (delta.tool_calls[0].function?.name) {
				yield {
					type: "tool_call_start",
					toolCallId: delta.tool_calls[0].id ?? "",
					name: delta.tool_calls[0].function.name,
				};
			}

			if (delta.tool_calls[0].function?.arguments) {
				yield {
					type: "tool_call_args_delta",
					content: delta.tool_calls[0].function.arguments,
				};
			}
		}
	}
}
