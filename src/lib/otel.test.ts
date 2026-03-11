import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@opentelemetry/api", () => ({
	trace: { disable: vi.fn() },
	metrics: { disable: vi.fn() },
	diag: { setLogger: vi.fn() },
	DiagLogLevel: { NONE: 0 },
}));

import { trace, metrics, diag } from "@opentelemetry/api";
import { disableOtelIfRequested } from "./otel.js";

describe("disableOtelIfRequested", () => {
	const originalEnv = process.env.OTEL_DISABLED;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.OTEL_DISABLED;
		} else {
			process.env.OTEL_DISABLED = originalEnv;
		}
	});

	it('disables OTel when OTEL_DISABLED is "true"', () => {
		process.env.OTEL_DISABLED = "true";
		disableOtelIfRequested();

		expect(trace.disable).toHaveBeenCalled();
		expect(metrics.disable).toHaveBeenCalled();
		expect(diag.setLogger).toHaveBeenCalled();
	});

	it('disables OTel when OTEL_DISABLED is "1"', () => {
		process.env.OTEL_DISABLED = "1";
		disableOtelIfRequested();

		expect(trace.disable).toHaveBeenCalled();
		expect(metrics.disable).toHaveBeenCalled();
		expect(diag.setLogger).toHaveBeenCalled();
	});

	it("does not disable OTel when OTEL_DISABLED is unset", () => {
		delete process.env.OTEL_DISABLED;
		disableOtelIfRequested();

		expect(trace.disable).not.toHaveBeenCalled();
		expect(metrics.disable).not.toHaveBeenCalled();
		expect(diag.setLogger).not.toHaveBeenCalled();
	});

	it('does not disable OTel when OTEL_DISABLED is "false"', () => {
		process.env.OTEL_DISABLED = "false";
		disableOtelIfRequested();

		expect(trace.disable).not.toHaveBeenCalled();
		expect(metrics.disable).not.toHaveBeenCalled();
		expect(diag.setLogger).not.toHaveBeenCalled();
	});

	it('does not disable OTel when OTEL_DISABLED is "0"', () => {
		process.env.OTEL_DISABLED = "0";
		disableOtelIfRequested();

		expect(trace.disable).not.toHaveBeenCalled();
		expect(metrics.disable).not.toHaveBeenCalled();
		expect(diag.setLogger).not.toHaveBeenCalled();
	});
});
