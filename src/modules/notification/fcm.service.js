const axios = require("axios");
const { GoogleAuth } = require("google-auth-library");
const path = require("path");

// Path to your Firebase service account JSON
const FIREBASE_SERVICE_ACCOUNT_PATH = path.join(__dirname, "../../utils/firebase.json");

const auth = new GoogleAuth({
  keyFile: FIREBASE_SERVICE_ACCOUNT_PATH,
  scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
});

let cachedAccessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedAccessToken && tokenExpiry && Date.now() < tokenExpiry - 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  cachedAccessToken = tokenResponse.token;
  // Assume token valid for 1 hour (default), set expiry to 50 minutes from now
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedAccessToken;
}

/**
 * Send a push notification using FCM v1 API
 * @param {Object} params
 * @param {string} params.to - FCM device token (from @react-native-firebase/messaging)
 * @param {string} params.title - Notification title
 * @param {string} params.body - Notification body
 * @param {Object} params.data - Additional data payload
 * @returns {Promise<Object>} - FCM response
 */
exports.sendPush = async ({ to, title, body, data }) => {
  try {
    const accessToken = await getAccessToken();

    const message = {
      message: {
        token: to,
        notification: {
          title,
          body,
        },
        data: data || {},
        android: {
          priority: "high",
          notification: {
            sound: "default",
            channelId: "default",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
            },
          },
        },
      },
    };

    const projectId = process.env.FIREBASE_PROJECT_ID || "mediwish-12215";
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const response = await axios.post(url, message, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    return response.data;
  } catch (error) {
    console.error("FCM send error:", error.response?.data || error.message);
    throw new Error(`Failed to send FCM notification: ${error.response?.data?.error?.message || error.message}`);
  }
};