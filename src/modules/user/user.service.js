const db = require("../../config/db");

exports.saveFcmToken = async (userId, token) => {
  await db.query(
    "UPDATE users SET fcm_token=? WHERE id=?",
    [token, userId]
  );
};

exports.getUserById = async (userId) => {
  const [rows] = await db.query(
    "SELECT * FROM users WHERE id=?",
    [userId]
  );
  return rows[0];
};