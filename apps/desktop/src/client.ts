import type {
  AppCommand, AppQuery, AsyncAppCommand, AsyncAppQuery,
  CommandResults, QueryResults, AsyncCommandResults, AsyncQueryResults
} from "@motion/app-service";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface MotionClient {
  execute<C extends AppCommand>(command: C): Promise<CommandResults[C["type"]]>;
  query<Q extends AppQuery>(query: Q): Promise<QueryResults[Q["type"]]>;
  executeAsync<C extends AsyncAppCommand>(command: C): Promise<AsyncCommandResults[C["type"]]>;
  queryAsync<Q extends AsyncAppQuery>(query: Q): Promise<AsyncQueryResults[Q["type"]]>;
}

type Lane = "command" | "query" | "async-command" | "async-query";

export function createTauriMotionClient(invoke: Invoke): MotionClient {
  const dispatch = <T>(lane: Lane, payload: unknown): Promise<T> =>
    invoke<unknown>("app_dispatch", { request: { protocolVersion: 1, lane, payload } }).then(decodeBinary) as Promise<T>;
  return {
    execute: command => dispatch("command", command),
    query: query => dispatch("query", query),
    executeAsync: command => dispatch("async-command", encodeBinary(command)),
    queryAsync: query => dispatch("async-query", encodeBinary(query))
  };
}

function decodeBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && Array.isArray(record.$motionBytes)) return Uint8Array.from(record.$motionBytes as number[]);
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decodeBinary(child)]));
  }
  return value;
}

// Tauri's JSON transport has no Uint8Array primitive. Only explicitly marked
// byte arrays are revived by the trusted service runner.
function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $motionBytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, encodeBinary(child)])
  );
  return value;
}
