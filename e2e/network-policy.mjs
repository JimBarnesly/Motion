/**
 * Compare a WebSocket URL with the configured HTTP(S) endpoint by normalized
 * hostname and effective port. The WebSocket scheme itself is intentionally
 * ignored: ws and wss are transports for the same configured local endpoint.
 */
export function isLocalWebSocketUrl(socketUrl, baseUrl) {
  try {
    const socket = new URL(socketUrl);
    const base = new URL(baseUrl);
    if (!['ws:', 'wss:'].includes(socket.protocol)) return false;
    if (!['http:', 'https:'].includes(base.protocol)) return false;

    const socketPort = socket.port || (socket.protocol === 'wss:' ? '443' : '80');
    const basePort = base.port || (base.protocol === 'https:' ? '443' : '80');
    return socket.hostname === base.hostname && socketPort === basePort;
  } catch {
    return false;
  }
}
