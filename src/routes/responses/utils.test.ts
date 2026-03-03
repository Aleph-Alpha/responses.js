import { describe, it, expect } from "vitest";
import type { Response as ExpressResponse } from "express";
import { buildJsonAttribute, requiresApproval, writeWithBackpressure } from "./utils.js";
import type { McpServerParams } from "../../schemas.js";
import { createMockRes } from "./__test_helpers__/mocks.js";

describe("buildJsonAttribute", () => {
	it("returns strings as-is", () => {
		expect(buildJsonAttribute("hello")).toBe("hello");
	});

	it("serializes objects to JSON", () => {
		expect(buildJsonAttribute({ key: "value" })).toBe('{"key":"value"}');
	});

	it("serializes arrays to JSON", () => {
		expect(buildJsonAttribute([1, 2, 3])).toBe("[1,2,3]");
	});

	it("serializes numbers", () => {
		expect(buildJsonAttribute(42)).toBe("42");
	});

	it("falls back to String() for non-serializable values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const result = buildJsonAttribute(circular);
		expect(result).toBe("[object Object]");
	});
});

describe("requiresApproval", () => {
	it("returns true when require_approval is 'always'", () => {
		const mapping = new Map<string, McpServerParams>([
			[
				"tool1",
				{
					server_label: "s1",
					server_url: "http://localhost",
					type: "mcp",
					allowed_tools: null,
					headers: null,
					require_approval: "always",
				},
			],
		]);
		expect(requiresApproval("tool1", mapping)).toBe(true);
	});

	it("returns false when require_approval is 'never'", () => {
		const mapping = new Map<string, McpServerParams>([
			[
				"tool1",
				{
					server_label: "s1",
					server_url: "http://localhost",
					type: "mcp",
					allowed_tools: null,
					headers: null,
					require_approval: "never",
				},
			],
		]);
		expect(requiresApproval("tool1", mapping)).toBe(false);
	});

	it("returns true when tool is in always.tool_names", () => {
		const mapping = new Map<string, McpServerParams>([
			[
				"tool1",
				{
					server_label: "s1",
					server_url: "http://localhost",
					type: "mcp",
					allowed_tools: null,
					headers: null,
					require_approval: {
						always: { tool_names: ["tool1"] },
					},
				},
			],
		]);
		expect(requiresApproval("tool1", mapping)).toBe(true);
	});

	it("returns false when tool is in never.tool_names", () => {
		const mapping = new Map<string, McpServerParams>([
			[
				"tool1",
				{
					server_label: "s1",
					server_url: "http://localhost",
					type: "mcp",
					allowed_tools: null,
					headers: null,
					require_approval: {
						never: { tool_names: ["tool1"] },
					},
				},
			],
		]);
		expect(requiresApproval("tool1", mapping)).toBe(false);
	});

	it("defaults to true when tool is not in any list", () => {
		const mapping = new Map<string, McpServerParams>([
			[
				"tool1",
				{
					server_label: "s1",
					server_url: "http://localhost",
					type: "mcp",
					allowed_tools: null,
					headers: null,
					require_approval: {
						always: { tool_names: ["other_tool"] },
						never: { tool_names: ["another_tool"] },
					},
				},
			],
		]);
		expect(requiresApproval("tool1", mapping)).toBe(true);
	});
});

describe("writeWithBackpressure", () => {
	it("resolves immediately when write returns true", async () => {
		const res = createMockRes();
		res.write.mockReturnValue(true);
		await writeWithBackpressure(res as unknown as ExpressResponse, "test data");
		expect(res.write).toHaveBeenCalledWith("test data");
	});

	it("waits for drain event when write returns false", async () => {
		const res = createMockRes();
		res.write.mockReturnValue(false);
		const listeners: Record<string, Function> = {};
		res.once.mockImplementation((event: string, cb: Function) => {
			listeners[event] = cb;
			return res;
		});

		const promise = writeWithBackpressure(res as unknown as ExpressResponse, "test data");

		// Simulate drain event
		expect(listeners["drain"]).toBeDefined();
		listeners["drain"]();

		await promise;
		expect(res.write).toHaveBeenCalledWith("test data");
		// Verify error listener was cleaned up
		expect(res.off).toHaveBeenCalledWith("error", listeners["error"]);
	});

	it("rejects on error event when write returns false", async () => {
		const res = createMockRes();
		res.write.mockReturnValue(false);
		const listeners: Record<string, Function> = {};
		res.once.mockImplementation((event: string, cb: Function) => {
			listeners[event] = cb;
			return res;
		});

		const promise = writeWithBackpressure(res as unknown as ExpressResponse, "test data");

		expect(listeners["error"]).toBeDefined();
		listeners["error"](new Error("write error"));

		await expect(promise).rejects.toThrow("write error");
		// Verify drain listener was cleaned up
		expect(res.off).toHaveBeenCalledWith("drain", listeners["drain"]);
	});
});
