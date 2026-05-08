// const db = require('../../config/db');
// const { generateToken } = require('../utils/agora');
// const { sendPush } = require('../services/notification/expo-push.service');

// /**
//  * Create a call room (channel) for an appointment.
//  * Called by a scheduled job 5 minutes before the appointment time.
//  */
// exports.createRoom = async (req, res) => {
//   try {
//     const { appointmentId, doctorId, patientId, callType = 'video' } = req.body;

//     if (!appointmentId || !doctorId || !patientId) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }

//     const channelName = `appt_${appointmentId}_${Date.now()}`;
//     const token = generateToken(channelName);

//     // Store channel info in the database (appointments table or separate call_rooms table)
//     await db.query(
//       `UPDATE appointments 
//        SET call_channel = ?, call_token = ?, call_created_at = NOW() 
//        WHERE id = ?`,
//       [channelName, token, appointmentId]
//     );

//     res.json({ channelName, token });
//   } catch (error) {
//     console.error('Create room error:', error);
//     res.status(500).json({ error: error.message });
//   }
// };

// /**
//  * Join an appointment call.
//  * Returns the channel name and token for the requesting user (doctor or patient).
//  * Also sends a push notification to the other party if the doctor joins.
//  */
// exports.joinAppointment = async (req, res) => {
//   try {
//     const { appointmentId, userId, userType } = req.body; // userType: 'doctor' or 'patient'

//     if (!appointmentId || !userId || !userType) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }

//     // Fetch appointment details and pre-created channel
//     const [rows] = await db.query(
//       `SELECT a.id, a.doctor_id, a.patient_id, a.call_channel, a.call_token,
//               d.name as doctor_name, p.name as patient_name,
//               d.expo_push_token as doctor_push_token, p.expo_push_token as patient_push_token
//        FROM appointments a
//        JOIN users d ON a.doctor_id = d.id
//        JOIN users p ON a.patient_id = p.id
//        WHERE a.id = ?`,
//       [appointmentId]
//     );

//     if (rows.length === 0) {
//       return res.status(404).json({ error: 'Appointment not found' });
//     }

//     const appt = rows[0];
//     if (!appt.call_channel || !appt.call_token) {
//       return res.status(400).json({ error: 'Call room not ready yet. Please wait.' });
//     }

//     // Return the existing channel & token for the requester
//     const response = {
//       channelName: appt.call_channel,
//       token: appt.call_token,
//     };

//     // If the doctor is joining AND the patient hasn't been notified yet,
//     // send a push notification to the patient.
//     if (userType === 'doctor') {
//       const patientToken = appt.patient_push_token;
//       if (patientToken) {
//         await sendPush({
//           to: patientToken,
//           type: 'join_call',
//           title: 'Doctor is ready',
//           body: `Dr. ${appt.doctor_name} has joined the call. Tap to join.`,
//           data: {
//             callerName: appt.doctor_name,
//             callerId: String(appt.doctor_id),
//             channelName: appt.call_channel,
//             token: appt.call_token,
//             callType: 'video', // adjust if needed
//             appointmentId: appt.id,
//           },
//           priority: 'high',
//           sound: 'default',
//         });
//         // Optionally mark that notification was sent (add a flag in DB)
//       }
//     }

//     res.json(response);
//   } catch (error) {
//     console.error('Join appointment error:', error);
//     res.status(500).json({ error: error.message });
//   }
// };

// modules/appointment/appointment.controller.js (No DB – static/in‑memory)
const { generateToken } = require('../../utils/agora');
const { sendPush } = require('../notification/expo-push.service');
// modules/appointment/appointment.controller.js

// In-memory store for call rooms (or use DB)
const callRooms = new Map();

/**
 * Join or Create appointment call room
 * If room doesn't exist, create it on the fly
 */
exports.joinAppointment = async (req, res) => {
  try {
    const { appointmentId, userId, userType, patientExpoToken, doctorName } = req.body;
    console.log(req.body);

    if (!appointmentId || !userId || !userType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let room = callRooms.get(appointmentId);
    
    // 🔥 AUTO-CREATE ROOM IF IT DOESN'T EXIST
    if (!room) {
      console.log(`📞 Room not found for ${appointmentId}, creating now...`);
      
      // In production, fetch doctorId/patientId from DB
      // For now, use dummy data or extract from request
      const doctorId = userType === 'doctor' ? userId : req.body.doctorId;
      const patientId = userType === 'patient' ? userId : req.body.patientId;
      
      const channelName = `appt_${appointmentId}_${Date.now()}`;
      const token = generateToken(channelName);
      
      room = {
        channelName,
        token,
        doctorId,
        patientId,
        createdAt: new Date().toISOString(),
        doctorJoined: false,
        patientJoined: false
      };
      
      callRooms.set(appointmentId, room);
      console.log(`✅ Room auto-created for appointment ${appointmentId}`);
    }

    // Update join status
    if (userType === 'doctor') {
      room.doctorJoined = true;
    } else {
      room.patientJoined = true;
    }

    // Prepare response
    const response = {
      channelName: room.channelName,
      token: room.token,
    };

    // If doctor is joining, send push notification to patient
    if (userType === 'doctor' && patientExpoToken) {
      const callerName = doctorName || `Doctor ${room.doctorId}`;
      
      await sendPush({
        to: patientExpoToken,
        type: 'join_call',
        title: 'Doctor is ready',
        body: `${callerName} has joined the call. Tap to join.`,
        data: {
          callerName,
          callerId: String(room.doctorId),
          channelName: room.channelName,
          token: room.token,
          callType: 'video',
          appointmentId,
        },
        priority: 'high',
        sound: 'default',
      });
      console.log(`📱 Push notification sent to patient`);
    }

    res.json(response);
  } catch (error) {
    console.error('Join appointment error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Optional: Clean up rooms after call ends
exports.endAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.body;
    
    if (callRooms.has(appointmentId)) {
      callRooms.delete(appointmentId);
      console.log(`🧹 Room cleaned up for ${appointmentId}`);
    }
    
    res.json({ success: true, message: 'Call ended, room cleaned up' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};