// modules/ride/ride.controller.js
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/db');
const { calculateDistance } = require('../../utils/goUtils');
const { logger } = require('../../utils/logger');

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// --------------------------------------------------------------
// Helper: Database query with retry
// --------------------------------------------------------------
async function queryWithRetry(sql, params, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const [rows] = await db.query(sql, params);
      return rows;
    } catch (err) {
      lastError = err;
      if (err.code === 'ECONNRESET' && i < retries - 1) {
        logger.warn(`Connection reset, retry ${i+1}...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i+1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// --------------------------------------------------------------
// Helper: Get available drivers
// --------------------------------------------------------------
async function getAvailableDrivers() {
  const sql = `
    SELECT w.*, u.socket_id 
    FROM warriors w
    LEFT JOIN users u ON w.user_id = u.id
    WHERE w.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = w.id
          AND r.status IN ('accepted', 'in-progress', 'picked-up')
      )
  `;
  return await queryWithRetry(sql, []);
}

// --------------------------------------------------------------
// Helper: Broadcast to user
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
// 1. Find nearby available drivers
// --------------------------------------------------------------
exports.findNearbyDrivers = async (req, res) => {
  try {
    const { lat, lng, radius = 10000 } = req.query;
    
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
  } catch (error) {
    logger.error('findNearbyDrivers error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 2. Book a ride
// --------------------------------------------------------------
exports.bookRide = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { userId, pickupLocation, dropoffLocation, paymentMethod, patientInfo, searchRadius = 5000 } = req.body;

    if (!userId || !pickupLocation || !dropoffLocation) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Check if user has active ride
    const [activeRides] = await connection.query(
      `SELECT id FROM rides WHERE user_id = ? AND status IN ('pending','accepted','in-progress','picked-up') LIMIT 1`,
      [userId]
    );
    if (activeRides.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'You already have an active ride' });
    }

    // Check for nearby drivers
    const availableDrivers = await getAvailableDrivers();
    let hasNearby = false;
    const nearbyDriversList = [];

    for (const driver of availableDrivers) {
      if (driver.lat && driver.lng) {
        const distance = calculateDistance(
          pickupLocation.lat, pickupLocation.lng,
          parseFloat(driver.lat), parseFloat(driver.lng)
        );
        if (distance <= searchRadius) {
          hasNearby = true;
          nearbyDriversList.push({
            id: driver.id,
            distance,
            socketId: driver.socket_id
          });
        }
      }
    }

    if (!hasNearby) {
      return res.status(400).json({
        success: false,
        message: `No nearby drivers available within ${searchRadius}m. Please try again later.`
      });
    }

    await connection.beginTransaction();

    // Create ride
    const rideId = uuidv4();
    const otp = generateOTP();
    
    await connection.query(
      `INSERT INTO rides (
        id, user_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        payment_method, patient_info, otp, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        rideId, userId,
        pickupLocation.lat, pickupLocation.lng,
        dropoffLocation.lat, dropoffLocation.lng,
        paymentMethod || 'cash',
        JSON.stringify(patientInfo || {}),
        otp
      ]
    );

    await connection.commit();

    // Broadcast to nearby drivers
    const io = req.app.get('io');
    if (io) {
      for (const driver of nearbyDriversList) {
        if (driver.socketId) {
          io.to(driver.socketId).emit('newRideRequest', {
            rideId,
            pickupLocation,
            dropoffLocation,
            patientInfo,
            distance: Math.round(driver.distance),
          });
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
// 3. Accept ride
// --------------------------------------------------------------
exports.acceptRide = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { rideId } = req.params;
    const { driverId } = req.body;

    await connection.beginTransaction();

    // Lock ride row
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

    // Check driver availability
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

    const otp = ride.otp;
    await connection.query(
      `UPDATE rides SET driver_id = ?, status = 'accepted', updated_at = NOW() WHERE id = ?`,
      [driverId, rideId]
    );

    await connection.commit();

    // Notify rider
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
// 4. Cancel ride (works with or without rideId)
// --------------------------------------------------------------
exports.cancelRide = async (req, res) => {
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
    
    // CASE 1: No rideId - cancel pending/searching request
    if (!rideId) {
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
      
      return res.json({
        success: true,
        message: 'Ride request cancelled successfully',
        rideId: pendingRide.id,
        status: 'cancelled'
      });
    }
    
    // CASE 2: rideId provided - cancel specific ride
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
    } else {
      const [rides] = await connection.query(
        `SELECT * FROM rides WHERE id = ? FOR UPDATE`,
        [rideId]
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
    
    // If ride was pending, notify all drivers
    if (ride.status === 'pending' && io) {
      io.emit('rideRequestCancelled', { rideId, reason });
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
    logger.error('cancelRide error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// --------------------------------------------------------------
// 5. Verify OTP
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
// 6. Get tracking info
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
// 7. Start ride
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
// 8. Complete ride
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
// 9. Get ride details (with or without rideId)
// --------------------------------------------------------------
exports.getRideDetails = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { userId, driverId } = req.query;
    
    let ride;
    
    if (rideId) {
      const [rides] = await db.query(`SELECT * FROM rides WHERE id = ?`, [rideId]);
      if (rides.length === 0) {
        return res.status(404).json({ success: false, message: 'Ride not found' });
      }
      ride = rides[0];
    } else if (userId) {
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
    } else {
      return res.status(400).json({ success: false, message: 'Either rideId, userId, or driverId is required' });
    }
    
    // Get driver info
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
    
    res.json({
      success: true,
      ride: {
        id: ride.id,
        status: ride.status,
        userId: ride.user_id,
        driverId: ride.driver_id,
        pickupLocation: { lat: ride.pickup_lat, lng: ride.pickup_lng },
        dropoffLocation: { lat: ride.dropoff_lat, lng: ride.dropoff_lng },
        paymentMethod: ride.payment_method,
        patientInfo: JSON.parse(ride.patient_info || '{}'),
        otp: ride.otp,
        otpVerified: !!ride.otp_verified,
        createdAt: ride.created_at,
        updatedAt: ride.updated_at,
        driver: driverInfo
      }
    });
  } catch (error) {
    logger.error('getRideDetails error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// --------------------------------------------------------------
// 10. Get user ride history
// --------------------------------------------------------------
exports.getUserRideHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const [rides] = await db.query(
      `SELECT * FROM rides WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), offset]
    );
    
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM rides WHERE user_id = ?`,
      [userId]
    );
    
    res.json({
      success: true,
      rides,
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
// Routes
// --------------------------------------------------------------
// const express = require('express');
// const router = express.Router();

// router.get('/find-drivers', exports.findNearbyDrivers);
// router.post('/book', exports.bookRide);
// router.put('/accept/:rideId', exports.acceptRide);
// router.delete('/cancel', exports.cancelRide);  // Cancel without rideId (searching state)
// router.post('/cancel/:rideId?', exports.cancelRide);  // Cancel with or without rideId
// router.post('/verify-otp', exports.verifyOtp);
// router.get('/tracking/:rideId', exports.getTracking);
// router.post('/start/:rideId', exports.startRide);
// router.post('/complete/:rideId', exports.completeRide);
// router.get('/details/:rideId?', exports.getRideDetails);
// router.get('/history/:userId', exports.getUserRideHistory);

// module.exports = router;