import type {
	ResponseContentPartAddedEvent,
	ResponseOutputMessage,
	ResponseFunctionToolCall,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import type {
	PatchedResponseReasoningItem,
	PatchedResponseStreamEvent,
	PatchedResponseContentPart,
	ReasoningTextContent,
	ReasoningSummaryTextContent,
} from "../../openai_patch";
import type { CreateResponseParams, McpServerParams } from "../../schemas.js";
import { generateUniqueId } from "../../lib/generateUniqueId.js";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import { type IncompleteResponse, StreamingError, SEQUENCE_NUMBER_PLACEHOLDER } from "./types.js";
import { requiresApproval } from "./utils.js";
import { finalizeLastOutputItem } from "./finalizeOutputItem.js";
import type { LLMOutputEvent } from "./llmEvents.js";

export type ReasoningSummaryMode = NonNullable<CreateResponseParams["reasoning"]>["summary"];

/**
 * Consume backend-agnostic LLMOutputEvents and produce Responses API SSE events.
 * Manages responseObject mutation, output item creation, and tool call classification.
 */
export async function* buildResponsesEvents(
	llmEvents: AsyncIterable<LLMOutputEvent>,
	responseObject: IncompleteResponse,
	mcpToolsMapping: Map<string, McpServerParams>,
	traceContext: Context,
	log: Logger,
	alreadyCalledMcpIds: Set<string>,
	reasoningSummaryMode: ReasoningSummaryMode = null
): AsyncGenerator<PatchedResponseStreamEvent> {
	let previousInputTokens = responseObject.usage?.input_tokens ?? 0;
	let previousOutputTokens = responseObject.usage?.output_tokens ?? 0;
	let previousTotalTokens = responseObject.usage?.total_tokens ?? 0;
	let currentTextMode: "text" | "reasoning" = "text";
	const mirrorRawReasoningToSummary = reasoningSummaryMode === "detailed";

	for await (const event of llmEvents) {
		switch (event.type) {
			case "usage": {
				responseObject.usage = {
					input_tokens: previousInputTokens + event.inputTokens,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: previousOutputTokens + event.outputTokens,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: previousTotalTokens + event.totalTokens,
				};
				break;
			}

			case "text_delta":
			case "reasoning_delta": {
				const isReasoning = event.type === "reasoning_delta";
				const targetMode = isReasoning ? "reasoning" : "text";

				// Close current output item on mode switch
				if (currentTextMode !== targetMode) {
					for await (const closeEvent of finalizeLastOutputItem(
						responseObject,
						traceContext,
						log,
						alreadyCalledMcpIds,
						mirrorRawReasoningToSummary
					)) {
						yield closeEvent;
					}
					currentTextMode = targetMode;
				}

				if (currentTextMode === "text") {
					// === Text handling ===
					const currentOutputItem = responseObject.output.at(-1);
					if (currentOutputItem?.type !== "message" || currentOutputItem?.status !== "in_progress") {
						const outputObject: ResponseOutputMessage = {
							id: generateUniqueId("msg"),
							type: "message",
							role: "assistant",
							status: "in_progress",
							content: [],
						};
						responseObject.output.push(outputObject);

						yield {
							type: "response.output_item.added",
							output_index: responseObject.output.length - 1,
							item: outputObject,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}

					const currentOutputMessage = responseObject.output.at(-1) as ResponseOutputMessage;
					if (currentOutputMessage.content.length === 0) {
						const contentPart: ResponseContentPartAddedEvent["part"] = {
							type: "output_text",
							text: "",
							annotations: [],
						};
						currentOutputMessage.content.push(contentPart);

						yield {
							type: "response.content_part.added",
							item_id: currentOutputMessage.id,
							output_index: responseObject.output.length - 1,
							content_index: currentOutputMessage.content.length - 1,
							part: contentPart,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}

					const contentPart = currentOutputMessage.content.at(-1);
					if (!contentPart || contentPart.type !== "output_text") {
						throw new StreamingError(
							`Not implemented: only output_text is supported in response.output[].content[].type. Got ${contentPart?.type}`
						);
					}

					contentPart.text += event.content;
					yield {
						type: "response.output_text.delta",
						item_id: currentOutputMessage.id,
						output_index: responseObject.output.length - 1,
						content_index: currentOutputMessage.content.length - 1,
						delta: event.content,
						logprobs: [],
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				} else {
					// === Reasoning handling ===
					const currentOutputItem = responseObject.output.at(-1);
					if (currentOutputItem?.type !== "reasoning" || currentOutputItem?.status !== "in_progress") {
						const outputObject: PatchedResponseReasoningItem = {
							id: generateUniqueId("rs"),
							type: "reasoning",
							status: "in_progress",
							content: [],
							summary: [],
						};
						responseObject.output.push(outputObject);

						yield {
							type: "response.output_item.added",
							output_index: responseObject.output.length - 1,
							item: outputObject,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}

					const currentReasoningItem = responseObject.output.at(-1) as PatchedResponseReasoningItem;
					if (mirrorRawReasoningToSummary) {
						let summaryPart = currentReasoningItem.summary.at(-1) as ReasoningSummaryTextContent | undefined;
						if (!summaryPart) {
							summaryPart = {
								type: "summary_text",
								text: "",
							};
							currentReasoningItem.summary.push(summaryPart);
							yield {
								type: "response.reasoning_summary_part.added",
								item_id: currentReasoningItem.id,
								output_index: responseObject.output.length - 1,
								summary_index: currentReasoningItem.summary.length - 1,
								part: summaryPart,
								sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
							};
						}
						summaryPart.text += event.content;
						yield {
							type: "response.reasoning_summary_text.delta",
							item_id: currentReasoningItem.id,
							output_index: responseObject.output.length - 1,
							summary_index: currentReasoningItem.summary.length - 1,
							delta: event.content,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					} else {
						if (currentReasoningItem.content.length === 0) {
							const contentPart: ReasoningTextContent = {
								type: "reasoning_text",
								text: "",
							};
							currentReasoningItem.content.push(contentPart);

							yield {
								type: "response.content_part.added",
								item_id: currentReasoningItem.id,
								output_index: responseObject.output.length - 1,
								content_index: currentReasoningItem.content.length - 1,
								part: contentPart as unknown as PatchedResponseContentPart, // TODO: adapt once openai-node is updated
								sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
							};
						}

						const contentPart = currentReasoningItem.content.at(-1) as ReasoningTextContent;
						contentPart.text += event.content;
						yield {
							type: "response.reasoning_text.delta",
							item_id: currentReasoningItem.id,
							output_index: responseObject.output.length - 1,
							content_index: currentReasoningItem.content.length - 1,
							delta: event.content,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}
				}
				break;
			}

			case "tool_call_start": {
				let newOutputObject:
					| ResponseOutputItem.McpCall
					| ResponseFunctionToolCall
					| ResponseOutputItem.McpApprovalRequest;
				const mcpToolParams = mcpToolsMapping.get(event.name);
				if (mcpToolParams) {
					if (requiresApproval(event.name, mcpToolsMapping)) {
						newOutputObject = {
							id: generateUniqueId("mcpr"),
							type: "mcp_approval_request",
							name: event.name,
							server_label: mcpToolParams.server_label,
							arguments: "",
						};
					} else {
						newOutputObject = {
							type: "mcp_call",
							id: generateUniqueId("mcp"),
							name: event.name,
							server_label: mcpToolParams.server_label,
							arguments: "",
						};
					}
				} else {
					newOutputObject = {
						type: "function_call",
						id: generateUniqueId("fc"),
						call_id: event.toolCallId,
						name: event.name,
						arguments: "",
					};
				}

				responseObject.output.push(newOutputObject);
				yield {
					type: "response.output_item.added",
					output_index: responseObject.output.length - 1,
					item: newOutputObject,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
				if (newOutputObject.type === "mcp_call" && !alreadyCalledMcpIds.has(newOutputObject.id)) {
					yield {
						type: "response.mcp_call.in_progress",
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						item_id: newOutputObject.id,
						output_index: responseObject.output.length - 1,
					};
				}
				break;
			}

			case "tool_call_args_delta": {
				const currentOutputItem = responseObject.output.at(-1) as
					| ResponseOutputItem.McpCall
					| ResponseFunctionToolCall
					| ResponseOutputItem.McpApprovalRequest;
				currentOutputItem.arguments += event.content;
				if (
					(currentOutputItem.type === "mcp_call" && !alreadyCalledMcpIds.has(currentOutputItem.id)) ||
					currentOutputItem.type === "function_call"
				) {
					yield {
						type:
							currentOutputItem.type === "mcp_call"
								? "response.mcp_call_arguments.delta"
								: "response.function_call_arguments.delta",
						item_id: currentOutputItem.id as string,
						output_index: responseObject.output.length - 1,
						delta: event.content,
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}
				break;
			}
		}
	}

	// Finalize the last output item after stream ends
	for await (const closeEvent of finalizeLastOutputItem(
		responseObject,
		traceContext,
		log,
		alreadyCalledMcpIds,
		mirrorRawReasoningToSummary
	)) {
		yield closeEvent;
	}
}
