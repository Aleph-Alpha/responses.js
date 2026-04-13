import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { version as packageVersion } from "../package.json";
import { URL } from "url";
import type { Logger } from "pino";

import type { McpServerParams } from "./schemas";
import { McpResultFormatter } from "./lib/McpResultFormatter";
import { mcpToolCallCounter, mcpToolCallDuration } from "./lib/metrics.js";

export async function connectMcpServer(mcpServer: McpServerParams, log: Logger): Promise<Client> {
	const mcp = new Client({ name: "@huggingface/responses.js", version: packageVersion });

	// Try to connect with http first, if that fails, try sse
	const url = new URL(mcpServer.server_url);
	const options = {
		requestInit: mcpServer.headers
			? {
					headers: mcpServer.headers,
				}
			: undefined,
	};
	try {
		const transport = new StreamableHTTPClientTransport(url, options);
		await mcp.connect(transport);
	} catch {
		const transport = new SSEClientTransport(url, options);
		await mcp.connect(transport);
	}

	log.info({ server_url: mcpServer.server_url }, "Connected to MCP server");

	return mcp;
}

export async function callMcpTool(
	mcpServer: McpServerParams,
	toolName: string,
	argumentsString: string,
	log: Logger
): Promise<{ error: string; output?: undefined } | { error?: undefined; output: string }> {
	const start = performance.now();
	let statusCode = 200;
	try {
		const client = await connectMcpServer(mcpServer, log);
		const toolArgs: Record<string, unknown> = argumentsString === "" ? {} : JSON.parse(argumentsString);
		log.info({ tool_name: toolName }, "Calling MCP tool");
		const toolResponse = await client.callTool({ name: toolName, arguments: toolArgs });
		const formattedResult = McpResultFormatter.format(toolResponse);
		if (toolResponse.isError) {
			throw new Error(`MCP tool call failed with error: ${formattedResult}`);
		}
		return {
			output: formattedResult,
		};
	} catch (error) {
		statusCode = 500;
		const errorMessage =
			error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
		return {
			error: errorMessage,
		};
	} finally {
		const durationSeconds = (performance.now() - start) / 1000;
		const metricAttrs = { status_code: statusCode, tool_name: toolName, server_label: mcpServer.server_label };
		mcpToolCallCounter.add(1, metricAttrs);
		mcpToolCallDuration.record(durationSeconds, metricAttrs);
	}
}
