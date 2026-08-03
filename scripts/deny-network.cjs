// Test-only process guard. Any attempted network use fails immediately and visibly.
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const dgram = require("node:dgram");
const dns = require("node:dns");

const denied = () => {
  throw new Error("Network access denied by Motion offline E2E guard");
};

net.connect = denied;
net.createConnection = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
dgram.createSocket = denied;
dns.lookup = denied;
dns.resolve = denied;
globalThis.fetch = denied;
globalThis.WebSocket = class OfflineWebSocket {
  constructor() { denied(); }
};
process.env.MOTION_NETWORK_DISABLED = "1";
