const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERT;

console.log('APP_ID:', APP_ID ? 'set' : 'missing');
console.log('CERTIFICATE:', APP_CERTIFICATE ? 'set' : 'missing');

/**
 * Generate an Agora token for a given channel and user ID.
 * @param {string} channelName
 * @param {number|string} uid - user ID (0 for all users)
 * @param {number} role - RtcRole.PUBLISHER or SUBSCRIBER
 * @returns {string}
 */
exports.generateToken = (channelName, uid = 0, role = RtcRole.PUBLISHER) => {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error('Missing Agora credentials in environment');
  }
  const expirationTimeInSeconds = 3600; // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  return RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );
};