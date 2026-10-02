// Serves prototype run folders so reports can be opened in a browser.
//   node tools/parity/serve.mjs [root] [port]    (defaults: %TEMP%/amluto-proto, 4174)
// Local only: binds to 127.0.0.1 and refuses paths outside the root.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? join(tmpdir(), "amluto-proto"));
const port = Number(process.argv[3] ?? 4174);
const types = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep) && file !== root) {
    response.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${path}`);
    return;
  }
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://localhost:${port}`));
