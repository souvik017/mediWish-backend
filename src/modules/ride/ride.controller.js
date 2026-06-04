// modules/ride/ride.controller.js
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/db');
const { calculateDistance } = require('../../utils/goUtils');
const { logger } = require('../../utils/logger');

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// --------------------------------------------------------------
// Helper: retry for ECONNRESET
// --------------------------------------------------------------
async function queryWithRetry(sql, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const [rows] = await db.query(sql, params);
      return rows;
    } catch (err) {
      if (err.code === 'ECONNRESET' && i < retries - 1) {
        console.warn(`Connection reset, retry ${i+1}...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i+1)));
        continue;
      }
      throw err;
    }
  }
}

// --------------------------------------------------------------
// Get available drivers (active, not on a ride)
// --------------------------------------------------------------
const getAvailableDrivers = async () => {
  const sql = `
    SELECT w.* 
    FROM warriors w
    WHERE w.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = w.id
          AND r.status IN ('accepted', 'in-progress', 'picked-up')
      )
  `;
  return await queryWithRetry(sql, []);
};

// --------------------------------------------------------------
// 1. Find nearby available drivers (optional, kept for frontend)
// --------------------------------------------------------------
exports.findNearbyDrivers = async (req, res) => {
  try {
    const { lat, lng, radius = 10000 } = req.query;
    console.log(lat, lng);
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng required' });
    }

    const availableDrivers = await getAvailableDrivers();
    const nearby = [];

    for (const driver of availableDrivers) {
      if (driver.lat && driver.lng) {
        const distance = calculateDistance(
          parseFloat(lat), parseFloat(lng),
          parseFloat(driver.lat), parseFloat(driver.lng)
        );
        if (distance <= radius) {
          nearby.push({
            id: driver.id,
            name: driver.full_name,
            vehicleNumber: driver.vehicle_number || 'Not provided',
            rating: 4.5,
            distance: Math.round(distance),
            location: { lat: parseFloat(driver.lat), lng: parseFloat(driver.lng) },
          });
        }
      }
    }

    nearby.sort((a, b) => a.distance - b.distance);
    res.json({ success: true, count: nearby.length, drivers: nearby });
    console.log(nearby)
  } catch (error) {
    logger.error('findNearbyDrivers error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 2. Book a ride – automatically checks for nearby drivers
// --------------------------------------------------------------
exports.bookRide = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { userId, pickupLocation, dropoffLocation, paymentMethod, patientInfo, searchRadius = 5000 } = req.body;

    if (!userId || !pickupLocation || !dropoffLocation) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 1️⃣ Check if there are ANY available drivers within the radius
    const availableDrivers = await getAvailableDrivers();
    let hasNearby = false;
    for (const driver of availableDrivers) {
      if (driver.lat && driver.lng) {
        const distance = calculateDistance(
          pickupLocation.lat, pickupLocation.lng,
          parseFloat(driver.lat), parseFloat(driver.lng)
        );
        if (distance <= searchRadius) {
          hasNearby = true;
          break;
        }
      }
    }

    if (!hasNearby) {
      return res.status(400).json({
        success: false,
        message: `No nearby drivers available within ${searchRadius}m. Please try again later.`
      });
    }

    // 2️⃣ Start transaction
    await connection.beginTransaction();

    // 3️⃣ Check user doesn't have an active ride
    const [activeRides] = await connection.query(
      `SELECT id FROM rides WHERE user_id = ? AND status IN ('pending','accepted','in-progress','picked-up') LIMIT 1`,
      [userId]
    );
    if (activeRides.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'You already have an active ride' });
    }

    // 4️⃣ Create ride record
    const rideId = uuidv4();
    await connection.query(
      `INSERT INTO rides (
        id, user_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        payment_method, patient_info, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        rideId,
        userId,
        pickupLocation.lat,
        pickupLocation.lng,
        dropoffLocation.lat,
        dropoffLocation.lng,
        paymentMethod || 'cash',
        JSON.stringify(patientInfo || {})
      ]
    );

    await connection.commit();

    // 5️⃣ Broadcast to nearby drivers (only those within radius)
    const io = req.app.get('io');
    if (io) {
      for (const driver of availableDrivers) {
        if (driver.lat && driver.lng && driver.socket_id) {
          const distance = calculateDistance(
            pickupLocation.lat, pickupLocation.lng,
            parseFloat(driver.lat), parseFloat(driver.lng)
          );
          if (distance <= searchRadius) {
            io.to(driver.socket_id).emit('newRideRequest', {
              rideId,
              pickupLocation,
              dropoffLocation,
              patientInfo,
              distance: Math.round(distance),
            });
          }
        }
      }
    }

    res.status(201).json({
      success: true,
      rideId,
      status: 'pending',
      message: 'Ride request sent to nearby drivers',
    });
  } catch (error) {
    await connection.rollback();
    logger.error('bookRide error', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// --------------------------------------------------------------
// 3. Driver accepts the ride (HTTP) – first come, first served
// --------------------------------------------------------------
exports.acceptRide = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { rideId } = req.params;
    const { driverId } = req.body;

    await connection.beginTransaction();

    // Lock ride row to prevent race conditions
    const [rides] = await connection.query(`SELECT * FROM rides WHERE id = ? FOR UPDATE`, [rideId]);
    if (rides.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    const ride = rides[0];
    if (ride.status !== 'pending') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: `Ride already ${ride.status}` });
    }

    // Check driver availability (active and not on another ride)
    const [drivers] = await connection.query(
      `SELECT * FROM warriors WHERE id = ? AND status = 'active' FOR UPDATE`,
      [driverId]
    );
    if (drivers.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Driver not available' });
    }

    const [activeRide] = await connection.query(
      `SELECT id FROM rides WHERE driver_id = ? AND status IN ('accepted', 'in-progress', 'picked-up')`,
      [driverId]
    );
    if (activeRide.length > 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Driver already on a ride' });
    }

    // Get user phone
    const [users] = await connection.query(`SELECT phone FROM users WHERE id = ?`, [ride.user_id]);
    const userPhone = users[0]?.phone || 'Not available';

    const otp = generateOTP();
    await connection.query(
      `UPDATE rides SET driver_id = ?, status = 'accepted', otp = ?, otp_verified = FALSE, updated_at = NOW() WHERE id = ?`,
      [driverId, otp, rideId]
    );

    await connection.commit();

    // Notify rider via socket
    const io = req.app.get('io');
    if (io) {
      const [riderSocket] = await connection.query(`SELECT socket_id FROM users WHERE id = ?`, [ride.user_id]);
      if (riderSocket[0]?.socket_id) {
        io.to(riderSocket[0].socket_id).emit('rideAccepted', {
          rideId,
          driver: {
            id: driverId,
            name: drivers[0].full_name,
            vehicleNumber: drivers[0].vehicle_number || 'Not provided',
            phone: drivers[0].phone,
          },
          pickupLocation: { lat: ride.pickup_lat, lng: ride.pickup_lng },
          otp,
          estimatedArrival: Math.floor(Math.random() * 10) + 5,
        });
      }
    }

    res.json({
      success: true,
      rideId,
      status: 'accepted',
      otp,
      userPhone,
      message: 'Ride accepted successfully',
    });
  } catch (error) {
    await connection.rollback();
    logger.error('acceptRide error', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// --------------------------------------------------------------
// 4. Verify OTP (HTTP)
// --------------------------------------------------------------
exports.verifyOtp = async (req, res) => {
  try {
    const { rideId, otp } = req.body;
    const [rides] = await db.query(`SELECT * FROM rides WHERE id = ?`, [rideId]);
    if (rides.length === 0) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    const ride = rides[0];
    if (ride.status !== 'accepted') {
      return res.status(400).json({ success: false, message: `Ride cannot be started (status: ${ride.status})` });
    }
    if (ride.otp !== otp) {
      return res.status(401).json({ success: false, message: 'Invalid OTP' });
    }

    await db.query(
      `UPDATE rides SET otp_verified = TRUE, status = 'in-progress', updated_at = NOW() WHERE id = ?`,
      [rideId]
    );

    const io = req.app.get('io');
    if (io) {
      const [user] = await db.query(`SELECT socket_id FROM users WHERE id = ?`, [ride.user_id]);
      const [driver] = await db.query(`SELECT socket_id FROM warriors WHERE id = ?`, [ride.driver_id]);
      if (user[0]?.socket_id) io.to(user[0].socket_id).emit('otpVerified', { rideId });
      if (driver[0]?.socket_id) io.to(driver[0].socket_id).emit('otpVerified', { rideId });
    }

    res.json({ success: true, message: 'OTP verified. Ride can now start.', rideId, status: 'in-progress' });
  } catch (error) {
    logger.error('verifyOtp error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 5. Get tracking info (HTTP)
// --------------------------------------------------------------
exports.getTracking = async (req, res) => {
  try {
    const { rideId } = req.params;
    const [rides] = await db.query(`SELECT * FROM rides WHERE id = ?`, [rideId]);
    if (rides.length === 0) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    const ride = rides[0];
    if (!['accepted', 'in-progress', 'picked-up'].includes(ride.status)) {
      return res.status(400).json({ success: false, message: 'Tracking not available for this ride status' });
    }

    const [drivers] = await db.query(`SELECT lat, lng FROM warriors WHERE id = ?`, [ride.driver_id]);
    if (drivers.length === 0 || !drivers[0].lat || !drivers[0].lng) {
      return res.status(404).json({ success: false, message: 'Driver location not available' });
    }

    res.json({
      success: true,
      rideId,
      status: ride.status,
      driverLocation: { lat: parseFloat(drivers[0].lat), lng: parseFloat(drivers[0].lng) },
      pickupLocation: { lat: ride.pickup_lat, lng: ride.pickup_lng },
      dropoffLocation: { lat: ride.dropoff_lat, lng: ride.dropoff_lng },
      lastUpdated: new Date(),
    });
  } catch (error) {
    logger.error('getTracking error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 6. Start ride (HTTP)
// --------------------------------------------------------------
exports.startRide = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { driverId } = req.body;
    const [rides] = await db.query(`SELECT * FROM rides WHERE id = ? AND driver_id = ?`, [rideId, driverId]);
    if (rides.length === 0) {
      return res.status(404).json({ success: false, message: 'Ride not found or not authorized' });
    }
    const ride = rides[0];
    if (ride.status !== 'in-progress') {
      return res.status(400).json({ success: false, message: `Cannot start ride (status: ${ride.status})` });
    }
    if (!ride.otp_verified) {
      return res.status(400).json({ success: false, message: 'OTP not verified yet' });
    }

    await db.query(
      `UPDATE rides SET status = 'picked-up', pickup_time = NOW(), updated_at = NOW() WHERE id = ?`,
      [rideId]
    );

    const io = req.app.get('io');
    if (io) {
      const [user] = await db.query(`SELECT socket_id FROM users WHERE id = ?`, [ride.user_id]);
      if (user[0]?.socket_id) {
        io.to(user[0].socket_id).emit('rideStarted', { rideId, message: 'Driver has picked you up' });
      }
    }

    res.json({ success: true, message: 'Ride started', rideId, status: 'picked-up' });
  } catch (error) {
    logger.error('startRide error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 7. Complete ride (HTTP)
// --------------------------------------------------------------
exports.completeRide = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { driverId } = req.body;
    const [rides] = await db.query(`SELECT * FROM rides WHERE id = ? AND driver_id = ?`, [rideId, driverId]);
    if (rides.length === 0) {
      return res.status(404).json({ success: false, message: 'Ride not found or not authorized' });
    }
    const ride = rides[0];
    if (ride.status !== 'picked-up') {
      return res.status(400).json({ success: false, message: `Ride cannot be completed (status: ${ride.status})` });
    }

    await db.query(
      `UPDATE rides SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [rideId]
    );

    const io = req.app.get('io');
    if (io) {
      const [user] = await db.query(`SELECT socket_id FROM users WHERE id = ?`, [ride.user_id]);
      if (user[0]?.socket_id) {
        io.to(user[0].socket_id).emit('rideCompleted', { rideId });
      }
    }

    res.json({ success: true, message: 'Ride completed successfully', rideId });
  } catch (error) {
    logger.error('completeRide error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};