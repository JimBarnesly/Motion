import { expect, test as base, type Page } from "@playwright/test";
import { isLocalWebSocketUrl } from "./network-policy.mjs";

export { expect, type Page };

/**
 * Every release browser test runs with external HTTP(S) and WebSocket traffic
 * denied before transfer. BrowserContext routing covers the initial page and
 * every additional page or popup in the fixture-owned context.
 */
export const test = base.extend<{ denyExternalNetwork: void }>({
  denyExternalNetwork: [async ({ context, baseURL }, use) => {
    const localOrigin = new URL(baseURL!).origin;
    const externalRequests: string[] = [];
    const externalSockets: string[] = [];

    await context.route(/^https?:\/\//, async route => {
      const url = route.request().url();
      if (new URL(url).origin === localOrigin) await route.continue();
      else {
        externalRequests.push(url);
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket(/^wss?:\/\//, async socket => {
      const url = socket.url();
      if (isLocalWebSocketUrl(url, baseURL!)) socket.connectToServer();
      else {
        externalSockets.push(url);
        await socket.close({ code: 1008, reason: "External WebSocket blocked by E2E network policy" });
      }
    });

    await use();

    expect(externalRequests, "browser acceptance attempted external HTTP(S) access").toEqual([]);
    expect(externalSockets, "browser acceptance attempted an external WebSocket").toEqual([]);
  }, { auto: true }]
});
