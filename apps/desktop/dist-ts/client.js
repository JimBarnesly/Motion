export function createTauriMotionClient(invoke) {
    const dispatch = (lane, payload) => invoke("app_dispatch", { request: { protocolVersion: 1, lane, payload } }).then(decodeBinary);
    return {
        execute: command => dispatch("command", command),
        query: query => dispatch("query", query),
        executeAsync: command => dispatch("async-command", encodeBinary(command)),
        queryAsync: query => dispatch("async-query", encodeBinary(query))
    };
}
function decodeBinary(value) {
    if (Array.isArray(value))
        return value.map(decodeBinary);
    if (value && typeof value === "object") {
        const record = value;
        if (Object.keys(record).length === 1 && Array.isArray(record.$motionBytes))
            return Uint8Array.from(record.$motionBytes);
        return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decodeBinary(child)]));
    }
    return value;
}
// Tauri's JSON transport has no Uint8Array primitive. Only explicitly marked
// byte arrays are revived by the trusted service runner.
function encodeBinary(value) {
    if (value instanceof Uint8Array)
        return { $motionBytes: Array.from(value) };
    if (Array.isArray(value))
        return value.map(encodeBinary);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeBinary(child)]));
    return value;
}
