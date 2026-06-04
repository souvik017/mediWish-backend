require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./config/db");

const userRoutes = require("./modules/user/user.routes");
const callRoutes = require("./modules/call/call.routes");
const appointmentRoutes = require("./modules/appointment/appointment.routes");
const rideRoutes = require("./modules/ride/ride.route");          // add this

// Import Socket.IO handlers
// const { setupSocketHandlers } = require("./modules/call/call.handlers");
const { setupRideSocketHandlers } = require("./modules/ride/ride.handler"); // add this

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─────────────────────────────
// 🛡️ MIDDLEWARE
// ─────────────────────────────
app.use(cors());
app.use(express.json());

// ─────────────────────────────
// 🔥 DB CONNECTION CHECK
// ─────────────────────────────
async function checkDB() {
  try {
    await db.query("SELECT 1");
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  }
}

// ─────────────────────────────
// ❤️ HEALTH CHECK
// ─────────────────────────────
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "API Running 🚀",
    time: new Date(),
  });
});

// ─────────────────────────────
// 🚀 ROUTES
// ─────────────────────────────
app.use("/user", userRoutes);
app.use("/call", callRoutes);
app.use("/appointment", appointmentRoutes);
app.use("/ride", rideRoutes);   // mount ride routes

// ─────────────────────────────
// 🔌 SOCKET.IO HANDLERS
// ─────────────────────────────
// setupSocketHandlers(io);               // existing call handlers
setupRideSocketHandlers(io, db);       // new ride handlers (pass db)

// Optional: expose io instance to routes if needed
app.set("io", io);

// ─────────────────────────────
// ❌ 404 HANDLER
// ─────────────────────────────
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ─────────────────────────────
// ⚠️ GLOBAL ERROR HANDLER
// ─────────────────────────────
app.use((err, req, res, next) => {
  console.error("🔥 ERROR:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

// ─────────────────────────────
// 🚨 UNHANDLED PROMISE ERRORS
// ─────────────────────────────
process.on("unhandledRejection", (err) => {
  console.error("💥 Unhandled Rejection:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  process.exit(1);
});

// ─────────────────────────────
// 🚀 START SERVER (USING http.SERVER)
// ─────────────────────────────
const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await checkDB();
});