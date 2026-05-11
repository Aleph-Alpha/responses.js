import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type {
	PatchedResponseContentPart,
	PatchedResponseReasoningItem,
	PatchedResponseStreamEvent,
	ReasoningSummaryTextContent,
} from "../../openai_patch";
import type { Attributes, Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import {
	type IncompleteResponse,
	StreamingError,
	SEQUENCE_NUMBER_PLACEHOLDER,
	tracer,
	OTEL_GENAI_CAPTURE_TOOL_CONTENT,
} from "./types.js";
import { buildJsonAttribute } from "./utils.js";

/**
 * Finalize the last output item — pure translation concern.
 * Emits "done" events for the last output item in the response.
 * Does NOT execute MCP tools or mutate the payload.
 */
export async function* finalizeLastOutputItem(
	responseObject: IncompleteResponse,
	traceContext: Context,
	_log: Logger,
	alreadyCalledMcpIds: Set<string> = new Set(),
	emitReasoningSummaryEvents = false
): AsyncGenerator<PatchedResponseStreamEvent> {
	const lastOutputItem = responseObject.output.at(-1);
	if (!lastOutputItem) return;

	if (lastOutputItem.type === "message") {
		const contentPart = lastOutputItem.content.at(-1);
		if (contentPart?.type === "output_text") {
			yield {
				type: "response.output_text.done",
				item_id: lastOutputItem.id,
				output_index: responseObject.output.length - 1,
				content_index: lastOutputItem.content.length - 1,
				text: contentPart.text,
				logprobs: [],
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};

			yield {
				type: "response.content_part.done",
				item_id: lastOutputItem.id,
				output_index: responseObject.output.length - 1,
				content_index: lastOutputItem.content.length - 1,
				part: contentPart,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else {
			throw new StreamingError("Not implemented: only output_text is supported in streaming mode.");
		}

		lastOutputItem.status = "completed";
		yield {
			type: "response.output_item.done",
			output_index: responseObject.output.length - 1,
			item: lastOutputItem,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} else if (lastOutputItem.type === "reasoning") {
		const reasoningItem = lastOutputItem as PatchedResponseReasoningItem;
		const contentPart = reasoningItem.content.at(-1);
		if (contentPart !== undefined) {
			yield {
				type: "response.reasoning_text.done",
				item_id: lastOutputItem.id,
				output_index: responseObject.output.length - 1,
				content_index: reasoningItem.content.length - 1,
				text: contentPart.text,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};

			yield {
				type: "response.content_part.done",
				item_id: lastOutputItem.id,
				output_index: responseObject.output.length - 1,
				content_index: reasoningItem.content.length - 1,
				part: contentPart as unknown as PatchedResponseContentPart, // TODO: adapt once openai-node is updated
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		}
		if (emitReasoningSummaryEvents) {
			for (const [summaryIndex, summaryPart] of reasoningItem.summary.entries()) {
				const part = summaryPart as ReasoningSummaryTextContent;
				yield {
					type: "response.reasoning_summary_text.done",
					item_id: lastOutputItem.id,
					output_index: responseObject.output.length - 1,
					summary_index: summaryIndex,
					text: part.text,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
				yield {
					type: "response.reasoning_summary_part.done",
					item_id: lastOutputItem.id,
					output_index: responseObject.output.length - 1,
					summary_index: summaryIndex,
					part,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			}
		}
		lastOutputItem.status = "completed";
		yield {
			type: "response.output_item.done",
			output_index: responseObject.output.length - 1,
			item: lastOutputItem,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} else if (lastOutputItem.type === "function_call") {
		const functionCallSpanAttributes: Attributes = {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": lastOutputItem.name,
			"gen_ai.tool.type": "function",
			"gen_ai.tool.call.id": lastOutputItem.call_id || lastOutputItem.id,
		};
		if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
			functionCallSpanAttributes["gen_ai.tool.call.arguments"] = buildJsonAttribute(lastOutputItem.arguments);
		}
		const functionCallSpan = tracer.startSpan(
			"gen_ai.execute_tool",
			{ attributes: functionCallSpanAttributes },
			traceContext
		);

		yield {
			type: "response.function_call_arguments.done",
			item_id: lastOutputItem.id as string,
			output_index: responseObject.output.length - 1,
			arguments: lastOutputItem.arguments,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};

		lastOutputItem.status = "completed";
		functionCallSpan.setAttribute("tool.status", "requested");
		yield {
			type: "response.output_item.done",
			output_index: responseObject.output.length - 1,
			item: lastOutputItem,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
		functionCallSpan.end();
	} else if (lastOutputItem.type === "mcp_call") {
		if (alreadyCalledMcpIds.has(lastOutputItem.id)) {
			// Already executed in a previous turn, skip
			return;
		}
		yield {
			type: "response.mcp_call_arguments.done",
			item_id: lastOutputItem.id as string,
			output_index: responseObject.output.length - 1,
			arguments: lastOutputItem.arguments,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
		// MCP tool execution is handled by executeMcpCall in the agentic loop (innerStream)
	} else if (lastOutputItem.type === "mcp_approval_request") {
		yield {
			type: "response.output_item.done",
			output_index: responseObject.output.length - 1,
			item: lastOutputItem,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} else if (lastOutputItem.type === "mcp_list_tools") {
		// Already finalized by `listMcpToolsStream`; do not re-emit done.
	} else {
		throw new StreamingError(
			`Not implemented: expected message, function_call, or mcp_call, got ${(lastOutputItem as ResponseOutputItem)?.type}`
		);
	}
}
