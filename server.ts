import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Store active bus locations
  const busLocations: Record<string, any> = {};

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Send current bus locations to new client
    socket.emit("all-bus-locations", busLocations);

    socket.on("update-bus-location", (data) => {
      console.log(`[${new Date().toLocaleTimeString()}] Location update from ${socket.id} for bus ${data.busId}`);
      // data: { busId, routeId, lat, lng, speed }
      busLocations[data.busId] = {
        ...data,
        lastUpdate: Date.now()
      };
      // Broadcast to all clients
      io.emit("bus-location-updated", busLocations[data.busId]);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
