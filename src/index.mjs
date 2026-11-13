import http from "node:http";
const port = Number(process.env.PORT || 3010);
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ service: "videoworker", status: "ready" }));
}).listen(port, "0.0.0.0", () => console.log(`videoworker listening on ${port}`));
