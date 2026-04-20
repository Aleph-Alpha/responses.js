import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	async function loadConfig(): Promise<(typeof import("./config.js"))["config"]> {
		const mod = await import("./config.js");
		return mod.config;
	}

	it("uses default values when env vars are not set", async () => {
		delete process.env.PORT;
		delete process.env.HOST;
		delete process.env.MCP_TIMEOUT_MS;
		delete process.env.LOG_LEVEL;
		delete process.env.LOG_PRETTY;
		delete process.env.OTEL_DISABLED;

		const cfg = await loadConfig();

		expect(cfg.port).toBe(3000);
		expect(cfg.host).toBe("0.0.0.0");
		expect(cfg.mcpTimeoutMs).toBe(30_000);
		expect(cfg.logLevel).toBe("info");
		expect(cfg.logPretty).toBe(false);
		expect(cfg.otelDisabled).toBe(false);
	});

	it("reads integer env vars correctly", async () => {
		process.env.PORT = "8080";
		process.env.MCP_TIMEOUT_MS = "60000";
		process.env.MAX_TOOL_ITERATIONS = "10";

		const cfg = await loadConfig();

		expect(cfg.port).toBe(8080);
		expect(cfg.mcpTimeoutMs).toBe(60000);
		expect(cfg.maxToolIterations).toBe(10);
	});

	it("reads boolean env vars correctly", async () => {
		process.env.LOG_PRETTY = "true";
		process.env.OTEL_DISABLED = "1";
		process.env.OTEL_GENAI_CAPTURE_TOOL_CONTENT = "true";

		const cfg = await loadConfig();

		expect(cfg.logPretty).toBe(true);
		expect(cfg.otelDisabled).toBe(true);
		expect(cfg.otelGenaiCaptureToolContent).toBe(true);
	});

	it("reads string env vars correctly", async () => {
		process.env.HOST = "127.0.0.1";
		process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
		process.env.LOG_LEVEL = "debug";

		const cfg = await loadConfig();

		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.openaiBaseUrl).toBe("http://localhost:11434/v1");
		expect(cfg.logLevel).toBe("debug");
	});

	it("throws on invalid integer env var", async () => {
		process.env.PORT = "not-a-number";

		await expect(loadConfig()).rejects.toThrow(
			'Invalid value for PORT: expected a non-negative integer, got "not-a-number"'
		);
	});

	it("throws on negative integer env var", async () => {
		process.env.PORT = "-1";

		await expect(loadConfig()).rejects.toThrow('Invalid value for PORT: expected a non-negative integer, got "-1"');
	});

	it("treats empty string env vars as unset", async () => {
		process.env.PORT = "";
		process.env.LOG_PRETTY = "";

		const cfg = await loadConfig();

		expect(cfg.port).toBe(3000);
		expect(cfg.logPretty).toBe(false);
	});

	it("boolean env vars treat non-true/1 values as false", async () => {
		process.env.OTEL_DISABLED = "false";
		process.env.LOG_PRETTY = "0";

		const cfg = await loadConfig();

		expect(cfg.otelDisabled).toBe(false);
		expect(cfg.logPretty).toBe(false);
	});
});
