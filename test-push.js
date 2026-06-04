// test-push.js
const { sendPush } = require("./src/modules/notification/expo-push.service");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

// ---------- Agora configuration (load from env or hardcode for test) ----------
const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID || "your_agora_app_id";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "your_agora_certificate";

// ---------- Generate Agora token (same logic as in your backend) ----------
function generateAgoraToken(channelName, uid = 0, role = RtcRole.PUBLISHER) {
  if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
    throw new Error("Agora credentials missing. Set EXPO_PUBLIC_AGORA_APP_ID and AGORA_APP_CERTIFICATE");
  }
  const expirationTimeInSeconds = 3600; // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );
}

// ---------- User's Expo push token (replace with actual token) ----------
const USER_EXPO_TOKEN = "ExponentPushToken[ayLoAkKI-_Zyq3zzFZCoBa]";

// ---------- Simulate a doctor initiating a call ----------
async function doctorInitiatesCall(doctorId, doctorName, patientExpoToken, channelName, callType = "video") {
  console.log(`📞 Doctor ${doctorName} (${doctorId}) is calling...`);
  console.log(`   Channel: ${channelName}`);

  // 1. Generate Agora token for this channel
  const agoraToken = generateAgoraToken(channelName);

  // 2. Send push notification to the patient
  const result = await sendPush({
    to: patientExpoToken,
    type: "join_call",
    title: `Incoming call from ${doctorName}`,
    body: `${doctorName} is waiting. Tap to join.`,
    data: {
      callerName: doctorName,
      callerId: String(doctorId),
      channelName: channelName,
      token: agoraToken,
      callType: callType,
    },
    priority: "high",
    sound: "default",
  });

  console.log("✅ Push notification sent:", result);
  return result;
}

// ---------- Optional: keep original test cases for other types ----------
async function testAllNotificationTypes() {
  try {
    // -------------------------------------------------
    // 1. Doctor initiates a call (new, main scenario)
    // -------------------------------------------------
    await doctorInitiatesCall(
      "doc_456",                                    // doctorId
      "Dr. Banerjee",                               // doctorName
      USER_EXPO_TOKEN,                              // patient's Expo token
      `call_${Date.now()}`,                         // unique channel name
      "video"
    );

    // -------------------------------------------------
    // 2. Appointment Reminder (existing test)
    // -------------------------------------------------
    console.log("\n⏰ Sending APPOINTMENT REMINDER...");
    const reminderResult = await sendPush({
      to: USER_EXPO_TOKEN,
      type: "appointment_reminder",
      title: "Upcoming Appointment",
      body: "You have an appointment with Dr. Smith at 5:00 PM.",
      data: {
        appointmentId: "apt_456",
        appointmentTime: "5:00 PM",
        doctorName: "Dr. Smith",
      },
    });
    console.log("✅ Reminder result:", reminderResult);

    // -------------------------------------------------
    // 3. Appointment Reschedule (existing test)
    // -------------------------------------------------
    console.log("\n📅 Sending APPOINTMENT RESCHEDULE...");
    const rescheduleResult = await sendPush({
      to: USER_EXPO_TOKEN,
      type: "appointment_reschedule",
      body: "Your appointment has been moved to 6:00 PM.",
      data: {
        appointmentId: "apt_456",
        oldTime: "5:00 PM",
        newTime: "6:00 PM",
        doctorName: "Dr. Smith",
      },
    });
    console.log("✅ Reschedule result:", rescheduleResult);

    // -------------------------------------------------
    // 4. Advertisement (existing test)
    // -------------------------------------------------
    console.log("\n🎉 Sending ADVERTISEMENT...");
    const adResult = await sendPush({
      to: USER_EXPO_TOKEN,
      type: "advertisement",
      title: "Special Discount!",
      body: "20% off your next consultation. Use code MEDI20.",
      data: {
        promoCode: "MEDI20",
        link: "https://yourapp.com/promo",
      },
    });
    console.log("✅ Advertisement result:", adResult);
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

// Run the test (only the doctor call scenario by default – comment/uncomment as needed)
(async () => {
  // Run only the doctor initiates call flow (no DB, no cron)
  await doctorInitiatesCall(
    "doc_456",                  // doctor ID
    "Dr. Banerjee",             // doctor name
    USER_EXPO_TOKEN,            // patient's Expo token
    `call_${Date.now()}`,       // unique channel name
    "video"
  );

  // If you also want to test other notification types, uncomment:
  // await testAllNotificationTypes();
})();