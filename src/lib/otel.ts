import { trace, metrics, diag, DiagLogLevel } from "@opentelemetry/api";

/**
 * Disables OpenTelemetry tracing, metrics, and diagnostics when no collector is available.
 *
 * Reads `OTEL_DISABLED` from the environment. Accepted values to disable:
 * - `"true"` or `"1"` — disables OTel
 * - Any other value (including unset) — OTel remains enabled
 *
 * When disabled, this function calls `trace.disable()`, `metrics.disable()`,
 * and sets a no-op diagnostic logger to suppress warning noise.
 */
export function disableOtelIfRequested(): void {
	if (process.env.OTEL_DISABLED === "true" || process.env.OTEL_DISABLED === "1") {
		trace.disable();
		metrics.disable();
		diag.setLogger(
			{
				error() {},
				warn() {},
				info() {},
				debug() {},
				verbose() {},
			},
			DiagLogLevel.NONE
		);
	}
}
