// services/notification/expo-push.service.js
const { Expo } = require("expo-server-sdk");

const expo = new Expo();

/**
 * Send a push notification using Expo
 * @param {Object} params
 * @param {string} params.to - Expo push token
 * @param {string} params.type - Notification type: 'advertisement' | 'appointment_reminder' | 'appointment_reschedule' | 'join_call'
 * @param {string} [params.title] - If not provided, defaults based on type
 * @param {string} [params.body] - If not provided, defaults based on type
 * @param {Object} [params.data] - Additional custom data (merged with type-specific data)
 * @param {string} [params.additionalData] - Any extra payload
 * @returns {Promise<Object>}
 */
exports.sendPush = async ({
  to,
  type,
  title,
  body,
  data = {},
  priority = "high",
  sound = "default",
}) => {
  try {
    if (!Expo.isExpoPushToken(to)) {
      throw new Error(`Invalid Expo push token: ${to}`);
    }

    // ----- Type-specific defaults -----
    let finalTitle = title;
    let finalBody = body;
    let channelId = "default";
    let categoryIdentifier = undefined;   // only for call notifications
    let ttl = undefined;                  // time-to-live in seconds
    let finalData = { type, ...data };

    switch (type) {
      case "join_call":
        finalTitle = finalTitle || "Incoming Call";
        finalBody = finalBody || `${data.callerName || "Someone"} is calling...`;
        channelId = "calls";
        categoryIdentifier = "call";       // shows Accept/Reject buttons
        priority = "high";
        ttl = 180;                          // expire after 60 seconds
        break;

      case "appointment_reminder":
        finalTitle = finalTitle || "Appointment Reminder";
        finalBody = finalBody || `Reminder: You have an appointment at ${data.appointmentTime || "soon"}.`;
        channelId = "default";
        priority = "high";
        ttl = 3600;                        // 1 hour
        break;

      case "appointment_reschedule":
        finalTitle = finalTitle || "Appointment Rescheduled";
        finalBody = finalBody || `Your appointment has been moved to ${data.newTime || "a new time"}.`;
        channelId = "default";
        priority = "high";
        ttl = 3600;
        break;

      case "advertisement":
        finalTitle = finalTitle || "Special Offer";
        finalBody = finalBody || "Check out our latest deals!";
        channelId = "default";
        priority = "normal";               // ads can be lower priority
        ttl = 86400;                       // 24 hours
        break;

      default:
        throw new Error(`Unsupported notification type: ${type}`);
    }

    // Build the message
    const message = {
      to,
      title: finalTitle,
      body: finalBody,
      data: finalData,
      sound,
      priority,
      channelId,
      ttl,
      badge: type === "join_call" ? 1 : undefined,  // badge only for calls
    };

    // Add category identifier only for calls (action buttons)
    if (categoryIdentifier) {
      message.categoryIdentifier = categoryIdentifier;
    }

    // Send
    const chunks = expo.chunkPushNotifications([message]);
    const tickets = [];
    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }

    return tickets[0];
  } catch (error) {
    console.error("❌ Expo push error:", error.message);
    throw error;
  }
};