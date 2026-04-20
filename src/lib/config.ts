/**
 * Centralized configuration module.
 *
 * Every environment variable the server reads is declared here with its type,
 * default value, and validation. Other modules import `config` instead of
 * reading `process.env` directly — this prevents typos, provides a single
 * inventory of tunables, and fails fast on bad values at startup.
 */

function parseIntEnv(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid value for ${name}: expected a non-negative integer, got "${raw}"`);
	}
	return parsed;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	return raw === "true" || raw === "1";
}

function parseStringEnv(name: string, defaultValue: string): string {
	return process.env[name] || defaultValue;
}

export const config = {
	// ── Server ────────────────────────────────────────────────────────────
	/** HTTP server listening port */
	port: parseIntEnv("PORT", 3000),
	/** HTTP server listening hostname/IP */
	host: parseStringEnv("HOST", "0.0.0.0"),
	/** SSE streaming backpressure buffer size (bytes) */
	streamHighWaterMark: parseIntEnv("STREAM_HIGH_WATER_MARK", 65536),
	/** TCP listen queue depth (SO_MAXCONN) */
	tcpBacklog: parseIntEnv("TCP_BACKLOG", 5000),
	/** Grace period (ms) before force-closing connections on shutdown */
	shutdownTimeoutMs: parseIntEnv("SHUTDOWN_TIMEOUT_MS", 10_000),

	// ── Upstream (LLM) ──────────────────────────────────────────────────
	/** Base URL for the Chat Completions backend */
	openaiBaseUrl: parseStringEnv("OPENAI_BASE_URL", "https://router.huggingface.co/v1"),
	/** Max connections per origin in the shared HTTP agent */
	upstreamMaxConnections: parseIntEnv("UPSTREAM_MAX_CONNECTIONS", 128),
	/** Keep-alive timeout (ms) for upstream connections */
	upstreamKeepAliveTimeoutMs: parseIntEnv("UPSTREAM_KEEP_ALIVE_TIMEOUT_MS", 30_000),
	/** Connection timeout (ms) for upstream requests */
	upstreamConnectTimeoutMs: parseIntEnv("UPSTREAM_CONNECT_TIMEOUT_MS", 30_000),
	/** Maximum time (ms) for an LLM streaming request */
	llmRequestTimeoutMs: parseIntEnv("LLM_REQUEST_TIMEOUT_MS", 300_000),

	// ── MCP ─────────────────────────────────────────────────────────────
	/** Timeout (ms) for MCP tool calls */
	mcpTimeoutMs: parseIntEnv("MCP_TIMEOUT_MS", 30_000),

	// ── Tool loop ───────────────────────────────────────────────────────
	/** Maximum iterations for the auto-tool-call loop */
	maxToolIterations: parseIntEnv("MAX_TOOL_ITERATIONS", 5),

	// ── Logging ─────────────────────────────────────────────────────────
	/** Pino log level (debug, info, warn, error, fatal) */
	logLevel: parseStringEnv("LOG_LEVEL", "info"),
	/** Enable pretty-printed JSON logs */
	logPretty: parseBoolEnv("LOG_PRETTY", false),

	// ── OpenTelemetry ───────────────────────────────────────────────────
	/** Disable OpenTelemetry tracing and metrics */
	otelDisabled: parseBoolEnv("OTEL_DISABLED", false),
	/** Capture tool arguments/results in GenAI spans */
	otelGenaiCaptureToolContent: parseBoolEnv("OTEL_GENAI_CAPTURE_TOOL_CONTENT", false),
} as const;
