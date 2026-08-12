import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = await realpath(root);
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
if (!LOOPBACK_HOSTS.has(host)) throw new Error("Motion web refuses non-loopback binding");

function parseAuthority(authority) {
  if (typeof authority !== "string" || /[\s,@/?#\\]/.test(authority)) return null;
  try {
    const parsed = new URL(`http:${"//"}${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, "")) ? parsed : null;
  } catch { return null; }
}
function originAllowed(origin, authority) {
  if (!origin) return true;
  const host = parseAuthority(authority);
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && !parsed.username && !parsed.password
      && parsed.pathname === "/" && !parsed.search && !parsed.hash
      && parsed.hostname === host.hostname && (parsed.port || "80") === (host.port || "80");
  }
  catch { return false; }
}
const securityHeaders = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const sharedAttachmentPolicy = resolve(root, "../../packages/core/dist/attachment-policy.js");

const server = createServer(async (request, response) => {
  if (!parseAuthority(request.headers.host) || !originAllowed(request.headers.origin, request.headers.host)) { response.writeHead(403, securityHeaders).end("Forbidden"); return; }
  if (!['GET', 'HEAD'].includes(request.method ?? "")) { response.writeHead(405, { ...securityHeaders, allow: "GET, HEAD" }).end("Method not allowed"); return; }
  let pathname;
  try {
    const target = request.url ?? "/";
    if (!target.startsWith("/")) throw new Error("absolute request target rejected");
    pathname = decodeURIComponent(target.split(/[?#]/, 1)[0]);
  }
  catch { response.writeHead(400, securityHeaders).end("Bad request"); return; }
  if (pathname === "/packages/core/dist/attachment-policy.js") {
    try {
      const policyFile = await realpath(sharedAttachmentPolicy);
      if (policyFile !== sharedAttachmentPolicy || !(await stat(policyFile)).isFile()) throw new Error("invalid shared policy");
      response.writeHead(200, { ...securityHeaders, "content-type": mime[".js"] });
      if (request.method === "HEAD") response.end(); else createReadStream(policyFile).pipe(response);
    } catch { response.writeHead(404, securityHeaders).end("Not found"); }
    return;
  }
  const candidate = resolve(canonicalRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!candidate.startsWith(`${canonicalRoot}${sep}`)) { response.writeHead(403, securityHeaders).end("Forbidden"); return; }
  try {
    const canonicalCandidate = await realpath(candidate);
    if (!canonicalCandidate.startsWith(`${canonicalRoot}${sep}`) || !(await stat(canonicalCandidate)).isFile()) { response.writeHead(403, securityHeaders).end("Forbidden"); return; }
    response.writeHead(200, { ...securityHeaders, "content-type": mime[extname(candidate)] ?? "application/octet-stream" });
    if (request.method === "HEAD") response.end(); else createReadStream(canonicalCandidate).pipe(response);
  } catch { response.writeHead(404, securityHeaders).end("Not found"); }
});
server.on("upgrade", (request, socket) => {
  const allowed = parseAuthority(request.headers.host) && originAllowed(request.headers.origin, request.headers.host);
  socket.end(`HTTP/1.1 ${allowed ? "426 Upgrade Required" : "403 Forbidden"}\r\nConnection: close\r\n\r\n`);
});
server.listen(port, host, () => console.log(`Motion web listening on ${host}:${server.address().port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
