import { redact } from "./redaction.js";
import type { JsonValue, PerformanceSpan } from "./types.js";

export class LocalPerformanceTracer {
  private readonly spans: PerformanceSpan[] = [];
  constructor(private readonly enabled: boolean, private readonly capacity = 200, private readonly clock = (): number => performance.now(), private readonly now = (): Date => new Date()) {}
  start(name: string, attributes: Record<string, unknown> = {}): () => PerformanceSpan | undefined {
    if (!this.enabled) return () => undefined;
    const start = this.clock();
    const startedAt = this.now().toISOString();
    return () => {
      const span: PerformanceSpan = { name, startedAt, durationMs: Math.max(0, this.clock() - start), attributes: redact(attributes) as Record<string, JsonValue> };
      this.spans.push(span);
      if (this.spans.length > this.capacity) this.spans.shift();
      return structuredClone(span);
    };
  }
  list(): readonly PerformanceSpan[] { return structuredClone(this.spans); }
}
