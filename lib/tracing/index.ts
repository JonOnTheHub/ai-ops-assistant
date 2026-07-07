import { supabase } from "@/lib/supabase";
import { TraceEntry } from "@/types";

export async function writeTrace(entry: TraceEntry): Promise<void> {
    const { error } = await supabase.from("trace_logs").insert({
        trace_id: entry.trace_id,
        step: entry.step,
        tool_name: entry.tool_name ?? null,
        input: entry.input,
        output: entry.output ?? null,
        status: entry.status,
        latency_ms: entry.latency_ms,
    });

    if (error) {
        // Tracing must never crash the agent
        // Log silently, never throw
        console.error("[trace] write failed:", error.message);
    }
}

// Convenience wrapper — handles timing for you
// Usage:
//   const result = await traced("plan", traceId, async () => { ... })
export async function traced<T>(
    step: TraceEntry["step"],
    trace_id: string,
    fn: () => Promise<T>,
    tool_name?: TraceEntry["tool_name"]
): Promise<{ result: T; latency_ms: number }> {
    const start = Date.now();

    try {
        const result = await fn();
        const latency_ms = Date.now() - start;

        await writeTrace({
            trace_id,
            step,
            tool_name,
            input: {},
            output: { result: JSON.stringify(result) },
            status: "success",
            latency_ms,
        });

        return { result, latency_ms };
    } catch (err) {
        const latency_ms = Date.now() - start;

        await writeTrace({
            trace_id,
            step,
            tool_name,
            input: {},
            output: { error: String(err) },
            status: "error",
            latency_ms,
        });

        throw err;
    }
}