import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type {
	PatchedResponseContentPart,
	PatchedResponseReasoningItem,
	PatchedResponseStreamEvent,
	ReasoningSummaryTextContent,
} from "../../openai_patch";
import type { McpServerParams } from "../../schemas.js";
import type { Attributes, Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import {
	type IncompleteResponse,
	StreamingError,
	SEQUENCE_NUMBER_PLACEHOLDER,
	tracer,
	OTEL_GENAI_CAPTURE_TOOL_CONTENT,
} from "./types.js";
import { buildJsonAttribute, recordError } from "./utils.js";
import { callMcpTool } from "../../mcp.js";

export async function* closeLastOutputItem(
	responseObject: IncompleteResponse,
	payload: ChatCompletionCreateParamsStreaming,
	mcpToolsMapping: Map<string, McpServerParams>,
	traceContext: Context,
	log: Logger,
	alreadyCalledMcpIds: Set<string> = new Set()
): AsyncGenerator<PatchedResponseStreamEvent> {
	const lastOutputItem = responseObject.output.at(-1);
	if (lastOutputItem) {
		if (lastOutputItem?.type === "message") {
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

			// Response output item done event
			lastOutputItem.status = "completed";
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else if (lastOutputItem?.type === "reasoning") {
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
			// Response output item done event
			lastOutputItem.status = "completed";
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else if (lastOutputItem?.type === "function_call") {
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
		} else if (lastOutputItem?.type === "mcp_call") {
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

			// Call MCP tool
			const toolParams = mcpToolsMapping.get(lastOutputItem.name);
			if (!toolParams) {
				throw new Error(`MCP tool '${lastOutputItem.name}' not found in tools mapping`);
			}
			const toolSpanAttributes: Attributes = {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": lastOutputItem.name,
				"gen_ai.tool.type": "extension",
				"gen_ai.tool.call.id": lastOutputItem.id,
				"mcp.server_label": lastOutputItem.server_label,
			};
			if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
				toolSpanAttributes["gen_ai.tool.call.arguments"] = buildJsonAttribute(lastOutputItem.arguments);
			}
			const toolSpan = tracer.startSpan("gen_ai.execute_tool", { attributes: toolSpanAttributes }, traceContext);

			let toolResult;
			try {
				toolResult = await callMcpTool(toolParams, lastOutputItem.name, lastOutputItem.arguments, log);
			} catch (error) {
				recordError(toolSpan, error);
				toolSpan.end();
				throw error;
			}
			if (toolResult.error) {
				lastOutputItem.error = toolResult.error;
				toolSpan.setAttribute("tool.status", "error");
				toolSpan.setAttribute("tool.error", toolResult.error);
				recordError(toolSpan, new Error(toolResult.error));
				yield {
					type: "response.mcp_call.failed",
					item_id: lastOutputItem.id as string,
					output_index: responseObject.output.length - 1,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			} else {
				lastOutputItem.output = toolResult.output;
				toolSpan.setAttribute("tool.status", "ok");
				if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
					toolSpan.setAttribute("gen_ai.tool.call.result", buildJsonAttribute(toolResult.output));
				}
				yield {
					type: "response.mcp_call.completed",
					item_id: lastOutputItem.id as string,
					output_index: responseObject.output.length - 1,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			}
			toolSpan.end();

			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};

			// Updating the payload for next LLM call only if the tool call succeeded
			if (!lastOutputItem.error) {
				payload.messages.push(
					{
						role: "assistant",
						tool_calls: [
							{
								id: lastOutputItem.id,
								type: "function",
								function: {
									name: lastOutputItem.name,
									arguments: lastOutputItem.arguments,
									// Hacky: type is not correct in inference.js. Will fix it but in the meantime we need to cast it.
									// TODO: fix it in the inference.js package. Should be "arguments" and not "parameters".
								},
							},
						],
					},
					{
						role: "tool",
						tool_call_id: lastOutputItem.id,
						content: lastOutputItem.output ?? "",
					}
				);
			} else {
				log.warn(
					{
						item_id: lastOutputItem.id,
						error: lastOutputItem.error,
					},
					"Not adding MCP tool output to payload due to error"
				);
			}
		} else if (lastOutputItem?.type === "mcp_approval_request" || lastOutputItem?.type === "mcp_list_tools") {
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else {
			throw new StreamingError(
				`Not implemented: expected message, function_call, or mcp_call, got ${(lastOutputItem as ResponseOutputItem)?.type}`
			);
		}
	}
}
