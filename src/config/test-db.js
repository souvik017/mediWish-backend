const mysql = require("mysql2/promise");

async function test() {
  try {
    const conn = await mysql.createConnection({
      host: "softskirl.co.in",
      user: "wzttpzqn_mediwishs",
      password: "Mediwishs@2026",
      database: "wzttpzqn_mediwishs",
      connectTimeout: 5000,
    });

    console.log("✅ Connected!");
    await conn.end();
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

test();