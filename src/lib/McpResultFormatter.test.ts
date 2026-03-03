import { describe, it, expect } from "vitest";
import { McpResultFormatter } from "./McpResultFormatter.js";

describe("McpResultFormatter", () => {
	it("returns [No content] for empty content", () => {
		expect(McpResultFormatter.format({ content: [] })).toBe("[No content]");
	});

	it("returns [No content] for undefined content", () => {
		expect(McpResultFormatter.format({} as Parameters<typeof McpResultFormatter.format>[0])).toBe("[No content]");
	});

	it("returns [No content] for null content", () => {
		expect(McpResultFormatter.format({ content: null } as Parameters<typeof McpResultFormatter.format>[0])).toBe(
			"[No content]"
		);
	});

	it("extracts text content directly", () => {
		const result = McpResultFormatter.format({
			content: [{ type: "text", text: "Hello world" }],
		});
		expect(result).toBe("Hello world");
	});

	it("joins multiple text contents with newlines", () => {
		const result = McpResultFormatter.format({
			content: [
				{ type: "text", text: "Line 1" },
				{ type: "text", text: "Line 2" },
			],
		});
		expect(result).toBe("Line 1\nLine 2");
	});

	it("summarizes image content with size", () => {
		// "SGVsbG8=" is base64 for "Hello" (5 bytes)
		const result = McpResultFormatter.format({
			content: [{ type: "image", data: "SGVsbG8=", mimeType: "image/png" }],
		});
		expect(result).toContain("[Binary Content: Image image/png,");
		expect(result).toContain("bytes]");
		expect(result).toContain("The task is complete");
	});

	it("summarizes audio content with size", () => {
		const result = McpResultFormatter.format({
			content: [{ type: "audio", data: "AAAA", mimeType: "audio/mp3" }],
		});
		expect(result).toContain("[Binary Content: Audio audio/mp3,");
		expect(result).toContain("bytes]");
	});

	it("handles text resource content", () => {
		const result = McpResultFormatter.format({
			content: [
				{
					type: "resource",
					resource: {
						uri: "file://test.txt",
						text: "Resource text content",
					},
				},
			],
		});
		expect(result).toBe("Resource text content");
	});

	it("handles blob resource content", () => {
		const result = McpResultFormatter.format({
			content: [
				{
					type: "resource",
					resource: {
						uri: "file://test.bin",
						blob: "SGVsbG8=",
						mimeType: "application/octet-stream",
					},
				},
			],
		});
		expect(result).toContain("[Binary Content");
		expect(result).toContain("(file://test.bin)");
		expect(result).toContain("application/octet-stream");
	});

	it("handles blob resource without mimeType", () => {
		const result = McpResultFormatter.format({
			content: [
				{
					type: "resource",
					resource: {
						uri: "",
						blob: "SGVsbG8=",
					},
				},
			],
		});
		expect(result).toContain("unknown type");
	});

	it("calculates base64 size correctly for padded strings", () => {
		// "SGVsbG8=" has 1 padding char → (8 * 3/4) - 1 = 5 bytes
		const result = McpResultFormatter.format({
			content: [{ type: "image", data: "SGVsbG8=", mimeType: "image/png" }],
		});
		expect(result).toContain("5 bytes");
	});

	it("calculates base64 size correctly for double-padded strings", () => {
		// "SGVs" is 4 chars, no padding → 3 bytes
		// "SGVsbA==" has 2 padding chars → (8 * 3/4) - 2 = 4 bytes
		const result = McpResultFormatter.format({
			content: [{ type: "image", data: "SGVsbA==", mimeType: "image/png" }],
		});
		expect(result).toContain("4 bytes");
	});

	it("handles base64 with data URI header", () => {
		const result = McpResultFormatter.format({
			content: [{ type: "image", data: "data:image/png;base64,SGVsbG8=", mimeType: "image/png" }],
		});
		expect(result).toContain("5 bytes");
	});

	it("handles mixed content types", () => {
		const result = McpResultFormatter.format({
			content: [
				{ type: "text", text: "Some text" },
				{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
			],
		});
		expect(result).toContain("Some text");
		expect(result).toContain("[Binary Content: Image image/jpeg,");
	});
});
