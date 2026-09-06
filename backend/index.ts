import { startWebServer } from "./server";

const PORT = parseInt(process.env.PORT || "4174", 10);
const HOST = process.env.HOST || "127.0.0.1";

console.log(`Starting web-terminal server on http://${HOST}:${PORT}`);
try {
  await startWebServer(HOST, PORT);
} catch (err) {
  console.error("[FATAL] Failed to start web-terminal server:", err);
  process.exit(1);
}
