import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdaptorServer } from "@hono/node-server";
import { disconnectPrisma } from "./db";
import { createApp } from "./http/app";
import { ensureBucketCors } from "./services/storage";
import { attachSockets } from "./socket/handlers";

const PORT = Number(process.env.PORT || 3000);
const app = createApp();
const server = createAdaptorServer({ fetch: app.fetch }) as ReturnType<typeof createServer>;

const io = new Server(server, {
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000,
  cors: { origin: true, credentials: true },
});

attachSockets(io);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Статус: http://localhost:${PORT}/api/status`);
  void ensureBucketCors().catch((error) => {
    console.error("CORS бакета kz-files не записан:", error instanceof Error ? error.message : error);
  });
});

async function shutdown() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await disconnectPrisma();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
