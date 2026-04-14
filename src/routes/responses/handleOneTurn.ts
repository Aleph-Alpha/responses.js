import { OpenAI } from "openai";
import { Agent } from "undici";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type {
	ResponseContentPartAddedEvent,
	ResponseOutputMessage,
	ResponseFunctionToolCall,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import type {
	PatchedResponseReasoningItem,
	PatchedResponseStreamEvent,
	PatchedDeltaWithReasoning,
	PatchedResponseContentPart,
	ReasoningTextContent,
} from "../../openai_patch";
import type { McpServerParams } from "../../schemas.js";
import { generateUniqueId } from "../../lib/generateUniqueId.js";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import { type IncompleteResponse, StreamingError, SEQUENCE_NUMBER_PLACEHOLDER, tracer } from "./types.js";
import { recordError, requiresApproval } from "./utils.js";
import { closeLastOutputItem } from "./closeOutputItem.js";
import { modelCallCounter, modelCallDuration } from "../../lib/metrics.js";

/*
 * Call LLM and stream the response.
 */
export async function* handleOneTurnStream(
	apiKey: string | undefined,
	payload: ChatCompletionCreateParamsStreaming,
	responseObject: IncompleteResponse,
	mcpToolsMapping: Map<string, McpServerParams>,
	defaultHeaders: Record<string, string>,
	traceContext: Context,
	log: Logger
): AsyncGenerator<PatchedResponseStreamEvent> {
	// Collect IDs of mcp_call items already executed in previous turns
	const alreadyCalledMcpIds = new Set(
		responseObject.output.filter((item) => item.type === "mcp_call").map((item) => item.id)
	);

	const llmSpan = tracer.startSpan(
		"gen_ai.chat",
		{
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": payload.model,
				"gen_ai.request.max_tokens": payload.max_tokens ?? undefined,
				"gen_ai.request.temperature": payload.temperature ?? undefined,
				"gen_ai.request.top_p": payload.top_p ?? undefined,
			},
		},
		traceContext
	);

	const client = new OpenAI({
		baseURL: process.env.OPENAI_BASE_URL ?? "https://router.huggingface.co/v1",
		apiKey: apiKey,
		defaultHeaders,
		fetchOptions: {
			dispatcher: new Agent({ allowH2: true }),
		},
	});
	const modelCallStart = performance.now();
	let modelCallStatusCode = 200;
	try {
		const stream = await client.chat.completions.create(payload);
		let previousInputTokens = responseObject.usage?.input_tokens ?? 0;
		let previousOutputTokens = responseObject.usage?.output_tokens ?? 0;
		let previousTotalTokens = responseObject.usage?.total_tokens ?? 0;
		let currentTextMode: "text" | "reasoning" = "text";

		for await (const chunk of stream) {
			if (chunk.usage) {
				// Overwrite usage with the latest chunk's usage
				responseObject.usage = {
					input_tokens: previousInputTokens + chunk.usage.prompt_tokens,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: previousOutputTokens + chunk.usage.completion_tokens,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: previousTotalTokens + chunk.usage.total_tokens,
				};
			}

			if (!chunk.choices[0]) {
				continue;
			}

			const delta = chunk.choices[0].delta as PatchedDeltaWithReasoning;
			const reasoningText = delta.reasoning ?? delta.reasoning_content;

			if (delta.content || reasoningText) {
				let currentOutputItem = responseObject.output.at(-1);

				// If start or end of reasoning, skip token and update the current text mode
				if (reasoningText) {
					if (currentTextMode === "text") {
						for await (const event of closeLastOutputItem(
							responseObject,
							payload,
							mcpToolsMapping,
							traceContext,
							log,
							alreadyCalledMcpIds
						)) {
							yield event;
						}
					}
					currentTextMode = "reasoning";
				} else if (delta.content) {
					if (currentTextMode === "reasoning") {
						for await (const event of closeLastOutputItem(
							responseObject,
							payload,
							mcpToolsMapping,
							traceContext,
							log,
							alreadyCalledMcpIds
						)) {
							yield event;
						}
					}
					currentTextMode = "text";
				}

				// If start of a new message, create it
				if (currentTextMode === "text") {
					if (currentOutputItem?.type !== "message" || currentOutputItem?.status !== "in_progress") {
						const outputObject: ResponseOutputMessage = {
							id: generateUniqueId("msg"),
							type: "message",
							role: "assistant",
							status: "in_progress",
							content: [],
						};
						responseObject.output.push(outputObject);

						// Response output item added event
						yield {
							type: "response.output_item.added",
							output_index: responseObject.output.length - 1,
							item: outputObject,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}
				} else if (currentTextMode === "reasoning") {
					if (currentOutputItem?.type !== "reasoning" || currentOutputItem?.status !== "in_progress") {
						const outputObject: PatchedResponseReasoningItem = {
							id: generateUniqueId("rs"),
							type: "reasoning",
							status: "in_progress",
							content: [],
							summary: [],
						};
						responseObject.output.push(outputObject);

						// Response output item added event
						yield {
							type: "response.output_item.added",
							output_index: responseObject.output.length - 1,
							item: outputObject,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}
				}

				// If start of a new content part, create it
				if (currentTextMode === "text") {
					const currentOutputMessage = responseObject.output.at(-1) as ResponseOutputMessage;
					if (currentOutputMessage.content.length === 0) {
						// Response content part added event
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

					// Add text delta
					contentPart.text += delta.content;
					yield {
						type: "response.output_text.delta",
						item_id: currentOutputMessage.id,
						output_index: responseObject.output.length - 1,
						content_index: currentOutputMessage.content.length - 1,
						delta: delta.content as string,
						logprobs: [],
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				} else if (currentTextMode === "reasoning") {
					const currentReasoningItem = responseObject.output.at(-1) as PatchedResponseReasoningItem;
					if (currentReasoningItem.content.length === 0) {
						// Response content part added event
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

					// Add text delta
					const contentPart = currentReasoningItem.content.at(-1) as ReasoningTextContent;
					contentPart.text += reasoningText;
					yield {
						type: "response.reasoning_text.delta",
						item_id: currentReasoningItem.id,
						output_index: responseObject.output.length - 1,
						content_index: currentReasoningItem.content.length - 1,
						delta: reasoningText as string,
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}
			} else if (delta.tool_calls && delta.tool_calls.length > 0) {
				if (delta.tool_calls.length > 1) {
					log.warn("Multiple tool calls not supported, only the first will be processed");
				}

				let currentOutputItem = responseObject.output.at(-1);
				if (delta.tool_calls[0].function?.name) {
					const functionName = delta.tool_calls[0].function.name;
					// Tool call with a name => new tool call
					let newOutputObject:
						| ResponseOutputItem.McpCall
						| ResponseFunctionToolCall
						| ResponseOutputItem.McpApprovalRequest;
					const mcpToolParams = mcpToolsMapping.get(functionName);
					if (mcpToolParams) {
						if (requiresApproval(functionName, mcpToolsMapping)) {
							newOutputObject = {
								id: generateUniqueId("mcpr"),
								type: "mcp_approval_request",
								name: functionName,
								server_label: mcpToolParams.server_label,
								arguments: "",
							};
						} else {
							newOutputObject = {
								type: "mcp_call",
								id: generateUniqueId("mcp"),
								name: functionName,
								server_label: mcpToolParams.server_label,
								arguments: "",
							};
						}
					} else {
						newOutputObject = {
							type: "function_call",
							id: generateUniqueId("fc"),
							call_id: delta.tool_calls[0].id ?? "",
							name: functionName,
							arguments: "",
						};
					}

					// Response output item added event
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
				}

				if (delta.tool_calls[0].function?.arguments) {
					// Current item is necessarily a tool call
					currentOutputItem = responseObject.output.at(-1) as
						| ResponseOutputItem.McpCall
						| ResponseFunctionToolCall
						| ResponseOutputItem.McpApprovalRequest;
					currentOutputItem.arguments += delta.tool_calls[0].function.arguments;
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
							delta: delta.tool_calls[0].function.arguments,
							sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						};
					}
				}
			}
		}

		for await (const event of closeLastOutputItem(
			responseObject,
			payload,
			mcpToolsMapping,
			traceContext,
			log,
			alreadyCalledMcpIds
		)) {
			yield event;
		}
	} catch (error) {
		if (error instanceof OpenAI.APIError) {
			modelCallStatusCode = error.status ?? 500;
		} else {
			modelCallStatusCode = 500;
		}
		recordError(llmSpan, error);
		throw error;
	} finally {
		const modelCallDurationSeconds = (performance.now() - modelCallStart) / 1000;
		const metricAttrs = { status_code: modelCallStatusCode, model_name: payload.model };
		modelCallCounter.add(1, metricAttrs);
		modelCallDuration.record(modelCallDurationSeconds, metricAttrs);
		if (responseObject.usage) {
			llmSpan.setAttributes({
				"gen_ai.usage.input_tokens": responseObject.usage.input_tokens,
				"gen_ai.usage.output_tokens": responseObject.usage.output_tokens,
			});
		}
		llmSpan.end();
	}
}
