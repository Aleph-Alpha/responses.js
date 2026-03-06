import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("responses.js");

// Model call metrics
export const modelCallCounter = meter.createCounter("responses_model_calls_total", {
	description: "Total number of model (LLM) calls",
});

export const modelCallDuration = meter.createHistogram("responses_model_call_duration_seconds", {
	description: "Duration of model (LLM) calls in seconds",
	unit: "s",
});

// MCP tool call metrics
export const mcpToolCallCounter = meter.createCounter("responses_mcp_tool_calls_total", {
	description: "Total number of MCP tool calls",
});

export const mcpToolCallDuration = meter.createHistogram("responses_mcp_tool_call_duration_seconds", {
	description: "Duration of MCP tool calls in seconds",
	unit: "s",
});
