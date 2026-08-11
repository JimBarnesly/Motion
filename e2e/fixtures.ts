import { expect, test as base, type Page } from "@playwright/test";

export { expect, type Page };

/**
 * Every release browser test runs with external HTTP(S) requests denied and
 * fails if the application even attempts an external request or WebSocket.
 * Loopback traffic to the configured development server remains available.
 */
export const test = base.extend<{ denyExternalNetwork: void }>({
  denyExternalNetwork: [async ({ context, page, baseURL }, use) => {
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
    page.on("websocket", socket => {
      if (new URL(socket.url()).origin !== localOrigin) externalSockets.push(socket.url());
    });

    await use();

    expect(externalRequests, "browser acceptance attempted external HTTP(S) access").toEqual([]);
    expect(externalSockets, "browser acceptance attempted an external WebSocket").toEqual([]);
  }, { auto: true }]
});
