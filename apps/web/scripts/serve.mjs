import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
if (!LOOPBACK_HOSTS.has(host)) throw new Error("Motion web refuses non-loopback binding");

function authorityAllowed(authority) {
  try { const parsed = new URL(`http:${"//"}${authority}`); return LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, "")); }
  catch { return false; }
}
function originAllowed(origin) {
  if (!origin) return true;
  try { const parsed = new URL(origin); return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname); }
  catch { return false; }
}
const securityHeaders = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

const server = createServer(async (request, response) => {
  if (!authorityAllowed(request.headers.host) || !originAllowed(request.headers.origin)) { response.writeHead(403, securityHeaders).end("Forbidden"); return; }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const candidate = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!candidate.startsWith(`${root}${sep}`)) { response.writeHead(403, securityHeaders).end("Forbidden"); return; }
  try {
    if (!(await stat(candidate)).isFile()) throw new Error("not a file");
    response.writeHead(200, { ...securityHeaders, "content-type": mime[extname(candidate)] ?? "application/octet-stream" });
    createReadStream(candidate).pipe(response);
  } catch { response.writeHead(404, securityHeaders).end("Not found"); }
});
server.on("upgrade", (_request, socket) => { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"); });
server.listen(port, host, () => console.log(`Motion web listening on ${host}:${server.address().port}`));
