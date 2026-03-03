import type { CreateResponseParams } from "../../schemas.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export function formatInputToMessages(
	input: CreateResponseParams["input"],
	instructions: string | null
): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = instructions ? [{ role: "system", content: instructions }] : [];

	if (Array.isArray(input)) {
		messages.push(
			...input
				.map((item) => {
					switch (item.type) {
						case "function_call":
							return {
								role: "tool" as const,
								content: item.arguments,
								tool_call_id: item.call_id,
							};
						case "function_call_output":
							return {
								role: "tool" as const,
								content: item.output,
								tool_call_id: item.call_id,
							};
						case "message":
						case undefined:
							if (item.role === "assistant" || item.role === "user" || item.role === "system") {
								const content =
									typeof item.content === "string"
										? item.content
										: item.content
												.map((content) => {
													switch (content.type) {
														case "input_image":
															return {
																type: "image_url" as const,
																image_url: {
																	url: content.image_url,
																},
															};
														case "output_text":
															return content.text
																? {
																		type: "text" as const,
																		text: content.text,
																	}
																: undefined;
														case "refusal":
															return undefined;
														case "input_text":
															return {
																type: "text" as const,
																text: content.text,
															};
													}
												})
												.filter((item) => {
													return item !== undefined;
												});
								const maybeFlatContent =
									content.length === 1 &&
									typeof content[0] === "object" &&
									"type" in content[0] &&
									content[0].type === "text"
										? content[0].text
										: content;
								return {
									role: item.role,
									content: maybeFlatContent,
								} as ChatCompletionMessageParam;
							}
							return undefined;
						case "mcp_list_tools": {
							return {
								role: "tool" as const,
								content: "MCP list tools. Server: '${item.server_label}'.",
								tool_call_id: "mcp_list_tools",
							};
						}
						case "mcp_call": {
							return {
								role: "tool" as const,
								content: `MCP call (${item.id}). Server: '${item.server_label}'. Tool: '${item.name}'. Arguments: '${item.arguments}'.`,
								tool_call_id: "mcp_call",
							};
						}
						case "mcp_approval_request": {
							return {
								role: "tool" as const,
								content: `MCP approval request (${item.id}). Server: '${item.server_label}'. Tool: '${item.name}'. Arguments: '${item.arguments}'.`,
								tool_call_id: "mcp_approval_request",
							};
						}
						case "mcp_approval_response": {
							return {
								role: "tool" as const,
								content: `MCP approval response (${item.id}). Approved: ${item.approve}. Reason: ${item.reason}.`,
								tool_call_id: "mcp_approval_response",
							};
						}
					}
				})
				.filter(
					(message): message is NonNullable<typeof message> =>
						message !== undefined &&
						(typeof message.content === "string" || (Array.isArray(message.content) && message.content.length !== 0))
				)
		);
	} else {
		messages.push({ role: "user", content: input } as const);
	}

	return messages;
}
