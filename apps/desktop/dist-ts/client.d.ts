import type { AppCommand, AppQuery, AsyncAppCommand, AsyncAppQuery, CommandResults, QueryResults, AsyncCommandResults, AsyncQueryResults } from "@motion/app-service";
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface MotionClient {
    execute<C extends AppCommand>(command: C): Promise<CommandResults[C["type"]]>;
    query<Q extends AppQuery>(query: Q): Promise<QueryResults[Q["type"]]>;
    executeAsync<C extends AsyncAppCommand>(command: C): Promise<AsyncCommandResults[C["type"]]>;
    queryAsync<Q extends AsyncAppQuery>(query: Q): Promise<AsyncQueryResults[Q["type"]]>;
}
export declare function createTauriMotionClient(invoke: Invoke): MotionClient;
