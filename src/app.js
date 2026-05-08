require("dotenv").config();
const express = require("express");
const cors = require("cors");

const db = require("./config/db");

const userRoutes = require("./modules/user/user.routes");
const callRoutes = require("./modules/call/call.routes");
const appointmentRoutes = require("./modules/appointment/appointment.routes");

const app = express();

// ─────────────────────────────
// 🛡️ MIDDLEWARE
// ─────────────────────────────
app.use(cors());
app.use(express.json());
require('dotenv').config();

// ─────────────────────────────
// 🔥 DB CONNECTION CHECK
// ─────────────────────────────
async function checkDB() {
  try {
    await db.query("SELECT 1");
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database connection failed:");
    console.error(err.message);
    process.exit(1); // ⛔ STOP SERVER if DB fails
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
app.use('/appointment', appointmentRoutes);

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
// 🚀 START SERVER
// ─────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await checkDB();
});