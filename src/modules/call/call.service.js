// controllers/callController.js (or wherever your startCall logic is)
const db = require("../../config/db");
const { generateToken } = require("../../utils/agora");
const { sendPush } = require("../notification/expo-push.service"); // 👈 changed to Expo service

exports.startCall = async ({ callerId, receiverId, channelName, callerName }) => {
  // 1. Get receiver's Expo push token from database
  const [rows] = await db.query(
    "SELECT expo_push_token FROM users WHERE id = ?",   // 👈 column name assumed
    [receiverId]
  );

  if (!rows.length || !rows[0].expo_push_token) {
    throw new Error("User has no Expo push token (not registered for notifications)");
  }

  const receiverToken = rows[0].expo_push_token;

  // 2. Generate Agora token
  const agoraToken = generateToken(channelName);

  // 3. Send push notification using Expo (type: 'join_call')
  const result = await sendPush({
    to: receiverToken,
    type: "join_call",                       // 👈 critical: tells frontend this is a call
    title: "Incoming Video Call",
    body: `${callerName || "Doctor"} is calling you`,
    data: {
      callerName: callerName || "Doctor",
      callerId: String(callerId),
      channelName,
      token: agoraToken,
      callType: "video",                     // or 'audio' based on your logic
    },
    priority: "high",
    sound: "default",
  });

  console.log("✅ Call notification sent:", result);
  return { token: agoraToken };
};