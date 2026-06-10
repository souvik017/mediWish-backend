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
// Helper: Broadcast to user via socket
// --------------------------------------------------------------
async function broadcastToUser(io, userId, event, data) {
  try {
    if (!io || !userId) return false;
    const [users] = await db.query(`SELECT socket_id FROM users WHERE id = ?`, [userId]);
    if (users[0]?.socket_id) {
      io.to(users[0].socket_id).emit(event, data);
      return true;
    }
  } catch (error) {
    logger.error(`Broadcast error to user ${userId}:`, error);
  }
  return false;
}

async function broadcastToDriver(io, driverId, event, data) {
  try {
    if (!io || !driverId) return false;
    const [drivers] = await db.query(`SELECT socket_id FROM warriors WHERE id = ?`, [driverId]);
    if (drivers[0]?.socket_id) {
      io.to(drivers[0].socket_id).emit(event, data);
      return true;
    }
  } catch (error) {
    logger.error(`Broadcast error to driver ${driverId}:`, error);
  }
  return false;
}

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

// --------------------------------------------------------------
// 8a. Cancel ride WITHOUT rideId (for searching/pending state)
// --------------------------------------------------------------
exports.cancelRideWithoutId = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    const { userId, driverId, reason = 'User cancelled' } = req.body;
    
    if (!userId && !driverId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either userId or driverId is required' 
      });
    }
    
    await connection.beginTransaction();
    
    let pendingRide;
    
    if (userId) {
      const [pendingRides] = await connection.query(
        `SELECT * FROM rides WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [userId]
      );
      pendingRide = pendingRides[0];
    } else if (driverId) {
      const [pendingRides] = await connection.query(
        `SELECT * FROM rides WHERE driver_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [driverId]
      );
      pendingRide = pendingRides[0];
    }
    
    if (!pendingRide) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'No pending ride request found to cancel' 
      });
    }
    
    // Cancel the pending ride
    await connection.query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = ?, updated_at = NOW() WHERE id = ?`,
      [reason, pendingRide.id]
    );
    
    await connection.commit();
    
    // Notify all drivers that this request is cancelled
    const io = req.app.get('io');
    if (io) {
      io.emit('rideRequestCancelled', { 
        rideId: pendingRide.id, 
        reason,
        cancelledBy: userId ? 'user' : 'driver'
      });
    }
    
    logger.info(`Pending ride ${pendingRide.id} cancelled by ${userId ? 'user' : 'driver'}`);
    
    res.json({
      success: true,
      message: 'Ride request cancelled successfully',
      rideId: pendingRide.id,
      status: 'cancelled'
    });
  } catch (error) {
    await connection.rollback();
    logger.error('cancelRideWithoutId error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// --------------------------------------------------------------
// 8b. Cancel ride WITH rideId (for accepted/in-progress rides)
// --------------------------------------------------------------
exports.cancelRideWithId = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    const { rideId } = req.params;
    const { userId, driverId, reason = 'User cancelled' } = req.body;
    
    if (!userId && !driverId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either userId or driverId is required' 
      });
    }
    
    await connection.beginTransaction();
    
    let ride;
    if (userId) {
      const [rides] = await connection.query(
        `SELECT * FROM rides WHERE id = ? AND user_id = ? FOR UPDATE`,
        [rideId, userId]
      );
      if (rides.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Ride not found' });
      }
      ride = rides[0];
    } else if (driverId) {
      const [rides] = await connection.query(
        `SELECT * FROM rides WHERE id = ? AND driver_id = ? FOR UPDATE`,
        [rideId, driverId]
      );
      if (rides.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Ride not found' });
      }
      ride = rides[0];
    }
    
    // Validate ride status for cancellation
    if (ride.status === 'completed') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Cannot cancel a completed ride' });
    }
    
    if (ride.status === 'cancelled') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Ride already cancelled' });
    }
    
    if (ride.status === 'picked-up') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Cannot cancel ride after pickup' });
    }
    
    // Cancel the ride
    await connection.query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = ?, updated_at = NOW() WHERE id = ?`,
      [reason, rideId]
    );
    
    // Make driver available again if assigned
    if (ride.driver_id) {
      await connection.query(
        `UPDATE warriors SET status = 'active' WHERE id = ?`,
        [ride.driver_id]
      );
    }
    
    await connection.commit();
    
    // Notify participants
    const io = req.app.get('io');
    const cancelData = {
      rideId,
      reason,
      cancelledBy: userId ? 'user' : (driverId ? 'driver' : 'system'),
      timestamp: new Date().toISOString()
    };
    
    if (ride.user_id) {
      await broadcastToUser(io, ride.user_id, 'rideCancelled', cancelData);
    }
    
    if (ride.driver_id) {
      await broadcastToDriver(io, ride.driver_id, 'rideCancelled', cancelData);
    }
    
    logger.info(`Ride ${rideId} cancelled by ${userId ? 'user' : (driverId ? 'driver' : 'system')}`);
    
    res.json({
      success: true,
      message: 'Ride cancelled successfully',
      rideId,
      status: 'cancelled'
    });
  } catch (error) {
    await connection.rollback();
    logger.error('cancelRideWithId error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// --------------------------------------------------------------
// 9a. Get ride details by query params (userId or driverId)
// --------------------------------------------------------------
exports.getRideDetails = async (req, res) => {
  try {
    const { userId, driverId } = req.query;
    
    if (!userId && !driverId) {
      return res.status(400).json({ success: false, message: 'Either userId or driverId is required' });
    }
    
    let ride;
    
    if (userId) {
      const [rides] = await db.query(
        `SELECT * FROM rides WHERE user_id = ? AND status IN ('pending','accepted','in-progress','picked-up') ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (rides.length === 0) {
        return res.status(404).json({ success: false, message: 'No active ride found' });
      }
      ride = rides[0];
    } else if (driverId) {
      const [rides] = await db.query(
        `SELECT * FROM rides WHERE driver_id = ? AND status IN ('accepted','in-progress','picked-up') ORDER BY created_at DESC LIMIT 1`,
        [driverId]
      );
      if (rides.length === 0) {
        return res.status(404).json({ success: false, message: 'No active ride found' });
      }
      ride = rides[0];
    }
    
    // Get driver info if assigned
    let driverInfo = null;
    if (ride.driver_id) {
      const [drivers] = await db.query(
        `SELECT id, full_name, phone, vehicle_number FROM warriors WHERE id = ?`,
        [ride.driver_id]
      );
      if (drivers.length > 0) {
        driverInfo = {
          id: drivers[0].id,
          name: drivers[0].full_name,
          phone: drivers[0].phone,
          vehicleNumber: drivers[0].vehicle_number
        };
      }
    }
    
    // Get user info
    const [users] = await db.query(
      `SELECT id, name, phone, email FROM users WHERE id = ?`,
      [ride.user_id]
    );
    
    res.json({
      success: true,
      ride: {
        id: ride.id,
        status: ride.status,
        userId: ride.user_id,
        driverId: ride.driver_id,
        pickupLocation: { 
          lat: parseFloat(ride.pickup_lat), 
          lng: parseFloat(ride.pickup_lng) 
        },
        dropoffLocation: { 
          lat: parseFloat(ride.dropoff_lat), 
          lng: parseFloat(ride.dropoff_lng) 
        },
        paymentMethod: ride.payment_method,
        patientInfo: JSON.parse(ride.patient_info || '{}'),
        otp: ride.otp,
        otpVerified: !!ride.otp_verified,
        createdAt: ride.created_at,
        updatedAt: ride.updated_at,
        pickupTime: ride.pickup_time,
        completedAt: ride.completed_at,
        cancelledAt: ride.cancelled_at,
        cancellationReason: ride.cancellation_reason,
        driver: driverInfo,
        user: users[0] || null
      }
    });
  } catch (error) {
    logger.error('getRideDetails error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 9b. Get ride details by rideId
// --------------------------------------------------------------
exports.getRideDetailsById = async (req, res) => {
  try {
    const { rideId } = req.params;
    
    if (!rideId) {
      return res.status(400).json({ success: false, message: 'Ride ID is required' });
    }
    
    const [rides] = await db.query(`SELECT * FROM rides WHERE id = ?`, [rideId]);
    if (rides.length === 0) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    
    const ride = rides[0];
    
    // Get driver info if assigned
    let driverInfo = null;
    if (ride.driver_id) {
      const [drivers] = await db.query(
        `SELECT id, full_name, phone, vehicle_number FROM warriors WHERE id = ?`,
        [ride.driver_id]
      );
      if (drivers.length > 0) {
        driverInfo = {
          id: drivers[0].id,
          name: drivers[0].full_name,
          phone: drivers[0].phone,
          vehicleNumber: drivers[0].vehicle_number
        };
      }
    }
    
    // Get user info
    const [users] = await db.query(
      `SELECT id, name, phone, email FROM users WHERE id = ?`,
      [ride.user_id]
    );
    
    res.json({
      success: true,
      ride: {
        id: ride.id,
        status: ride.status,
        userId: ride.user_id,
        driverId: ride.driver_id,
        pickupLocation: { 
          lat: parseFloat(ride.pickup_lat), 
          lng: parseFloat(ride.pickup_lng) 
        },
        dropoffLocation: { 
          lat: parseFloat(ride.dropoff_lat), 
          lng: parseFloat(ride.dropoff_lng) 
        },
        paymentMethod: ride.payment_method,
        patientInfo: JSON.parse(ride.patient_info || '{}'),
        otp: ride.otp,
        otpVerified: !!ride.otp_verified,
        createdAt: ride.created_at,
        updatedAt: ride.updated_at,
        pickupTime: ride.pickup_time,
        completedAt: ride.completed_at,
        cancelledAt: ride.cancelled_at,
        cancellationReason: ride.cancellation_reason,
        driver: driverInfo,
        user: users[0] || null
      }
    });
  } catch (error) {
    logger.error('getRideDetailsById error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
// --------------------------------------------------------------
// 10. Get user ride history (NEW)
// --------------------------------------------------------------
exports.getUserRideHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10, status } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `SELECT * FROM rides WHERE user_id = ?`;
    let params = [userId];
    
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);
    
    const [rides] = await db.query(sql, params);
    
    // Get count for pagination
    let countSql = `SELECT COUNT(*) as total FROM rides WHERE user_id = ?`;
    let countParams = [userId];
    if (status) {
      countSql += ` AND status = ?`;
      countParams.push(status);
    }
    const [countResult] = await db.query(countSql, countParams);
    
    // Enrich with driver info
    const enrichedRides = await Promise.all(rides.map(async (ride) => {
      let driverInfo = null;
      if (ride.driver_id) {
        const [drivers] = await db.query(
          `SELECT id, full_name, phone, vehicle_number FROM warriors WHERE id = ?`,
          [ride.driver_id]
        );
        if (drivers.length > 0) {
          driverInfo = {
            id: drivers[0].id,
            name: drivers[0].full_name,
            phone: drivers[0].phone,
            vehicleNumber: drivers[0].vehicle_number
          };
        }
      }
      
      return {
        id: ride.id,
        status: ride.status,
        pickupLocation: { 
          lat: parseFloat(ride.pickup_lat), 
          lng: parseFloat(ride.pickup_lng) 
        },
        dropoffLocation: { 
          lat: parseFloat(ride.dropoff_lat), 
          lng: parseFloat(ride.dropoff_lng) 
        },
        paymentMethod: ride.payment_method,
        createdAt: ride.created_at,
        completedAt: ride.completed_at,
        cancelledAt: ride.cancelled_at,
        cancellationReason: ride.cancellation_reason,
        driver: driverInfo
      };
    }));
    
    res.json({
      success: true,
      rides: enrichedRides,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0]?.total || 0,
        totalPages: Math.ceil((countResult[0]?.total || 0) / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('getUserRideHistory error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// Routes (add these to your ride.route.js file)
// --------------------------------------------------------------
// Add these to your existing routes in ride.route.js:
/*
router.post('/cancel/:rideId?', rideController.cancelRide);
router.get('/details/:rideId?', rideController.getRideDetails);
router.get('/history/:userId', rideController.getUserRideHistory);
*/