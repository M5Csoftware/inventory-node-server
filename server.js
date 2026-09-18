import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyCompress from "@fastify/compress";
import fastifyMultipart from "@fastify/multipart";
import mongoose from "mongoose";
import dotenv from "dotenv";

// Invoice Registration App Routes
import invoiceRegistrationRoutes from "./invoice-registration/routes.js";

// Inventory Management App Routes
import inventoryRoutes from "./inventory-management/routes.js";

dotenv.config();

if (!process.env.MONGODB_URI) {
  console.error("FATAL ERROR: MONGODB_URI is not defined.");
  process.exit(1);
}

const fastify = Fastify({
  bodyLimit: 50 * 1024 * 1024, // 50MB limit to handle large invoice scans
  logger: { level: process.env.LOG_LEVEL || "info" },
});

const frontendUrl = process.env.FRONTEND_URL || "*";

fastify.register(fastifyCors, {
  origin: (origin, cb) => {
    // Allow non-browser requests (curl, server-to-server, etc.)
    if (!origin) return cb(null, true);

    // If wildcard configured
    if (frontendUrl === "*") return cb(null, true);

    // Always allow any Vercel domain and localhost
    if (
      origin === frontendUrl ||
      origin.endsWith(".vercel.app") ||
      origin.includes("localhost") ||
      origin.includes("127.0.0.1")
    ) {
      return cb(null, true);
    }

    return cb(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-database"],
  credentials: true,
});

fastify.register(fastifyCompress, { threshold: 1024 });
fastify.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });

// Health check endpoints
fastify.get("/", async () => ({
  status: "M5 Inventory & Invoice Server is Running",
  service: "inventory-node-server",
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
}));

fastify.get("/health", async () => ({
  status: "ok",
  db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  timestamp: new Date().toISOString(),
}));

// Register Invoice Registration plugin
fastify.register(invoiceRegistrationRoutes, { prefix: "/api/invoice-registration" });

// Register Inventory Management plugin
fastify.register(inventoryRoutes, { prefix: "/api/inventory" });

const connectDB = async () => {
  mongoose.connection.on("disconnected", () =>
    console.warn("MongoDB disconnected!")
  );
  mongoose.connection.on("error", (err) =>
    console.error(`MongoDB error: ${err.message}`)
  );
  const conn = await mongoose.connect(process.env.MONGODB_URI);
  console.log(`MongoDB Connected: ${conn.connection.host} [DB: ${conn.connection.name}]`);
};

const start = async () => {
  try {
    await connectDB();
    const port = parseInt(process.env.PORT, 10) || 5000;
    const host = process.env.HOST || "0.0.0.0";

    await fastify.listen({ port, host });
    console.log(`Inventory Server listening on http://${host}:${port}`);
    console.log(`Inventory API: http://${host}:${port}/api/inventory`);
    console.log(`Invoice API:   http://${host}:${port}/api/invoice-registration`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

const closeGracefully = async (signal) => {
  console.log(`\n[${signal}] Shutting down Inventory Server...`);
  try {
    await fastify.close();
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error("Shutdown error:", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => closeGracefully("SIGINT"));
process.on("SIGTERM", () => closeGracefully("SIGTERM"));
