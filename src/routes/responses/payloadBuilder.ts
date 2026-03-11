import type { ChatCompletionCreateParamsStreaming, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { CreateResponseParams } from "../../schemas.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export function buildLLMPayload(
	body: CreateResponseParams,
	messages: ChatCompletionMessageParam[],
	tools: ChatCompletionTool[] | undefined
): ChatCompletionCreateParamsStreaming {
	return {
		// main params
		model: body.model,
		messages,
		stream: true,
		// options
		max_tokens: body.max_output_tokens === null ? undefined : body.max_output_tokens,
		response_format: body.text?.format
			? body.text.format.type === "json_schema"
				? {
						type: "json_schema",
						json_schema: {
							description: body.text.format.description,
							name: body.text.format.name,
							schema: body.text.format.schema,
							strict: false, // body.text.format.strict,
						},
					}
				: { type: body.text.format.type }
			: undefined,
		reasoning_effort: body.reasoning?.effort,
		temperature: body.temperature,
		tool_choice:
			typeof body.tool_choice === "string"
				? body.tool_choice
				: body.tool_choice
					? {
							type: "function",
							function: {
								name: body.tool_choice.name,
							},
						}
					: undefined,
		tools,
		top_p: body.top_p,
		stream_options: {
			include_usage: true,
		},
	};
}
