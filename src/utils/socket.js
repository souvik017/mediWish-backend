// socket.js
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

// Helper to generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

module.exports = (server, db) => {
  const io = new Server(server, {
    cors: {
      origin: "*", // restrict in production
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log(`New socket connected: ${socket.id}`);

    // ------------------- DRIVER REGISTRATION & LOCATION -------------------
    socket.on("registerDriver", async (data) => {
      const { driverId } = data;
      if (!driverId) return socket.emit("error", "Driver ID required");

      try {
        const [drivers] = await db.query(
          "UPDATE warriors SET socket_id = ? WHERE id = ? AND status = 'active'",
          [socket.id, driverId]
        );
        if (drivers.affectedRows === 0) {
          return socket.emit("error", "Driver not found or inactive");
        }
        console.log(`Driver ${driverId} registered with socket ${socket.id}`);
        socket.emit("driverRegistered", { success: true });
      } catch (err) {
        console.error(err);
        socket.emit("error", "Database error");
      }
    });

    socket.on("updateDriverLocation", async (data) => {
      const { driverId, lat, lng } = data;
      if (!driverId || !lat || !lng) return;

      try {
        await db.query(
          "UPDATE warriors SET lat = ?, lng = ? WHERE id = ?",
          [lat, lng, driverId]
        );
        // Optionally emit to riders who are tracking this driver
        const [rides] = await db.query(
          `SELECT user_id FROM rides 
           WHERE driver_id = ? AND status IN ('accepted','in-progress','picked-up')`,
          [driverId]
        );
        for (const ride of rides) {
          const [users] = await db.query(
            "SELECT socket_id FROM users WHERE id = ?",
            [ride.user_id]
          );
          if (users[0]?.socket_id) {
            io.to(users[0].socket_id).emit("driverLocationUpdate", {
              driverId,
              location: { lat, lng },
            });
          }
        }
      } catch (err) {
        console.error(err);
      }
    });

    // ------------------- RIDER REGISTRATION -------------------
    socket.on("registerRider", async (data) => {
      const { riderId, lat, lng } = data;
      if (!riderId) return;

      try {
        await db.query(
          "UPDATE users SET socket_id = ?, lat = ?, lng = ? WHERE id = ?",
          [socket.id, lat || null, lng || null, riderId]
        );
        console.log(`Rider ${riderId} registered`);
        socket.emit("riderRegistered", { success: true });
      } catch (err) {
        console.error(err);
        socket.emit("error", "Failed to register rider");
      }
    });

    // ------------------- DRIVER ACCEPTS RIDE (socket version) -------------------
    socket.on("acceptRide", async (data) => {
      const { rideId, driverId } = data;
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();

        // Lock and fetch ride
        const [rides] = await connection.query(
          "SELECT * FROM rides WHERE id = ? FOR UPDATE",
          [rideId]
        );
        if (rides.length === 0) throw new Error("Ride not found");
        const ride = rides[0];
        if (ride.status !== "pending") throw new Error(`Ride already ${ride.status}`);

        // Check driver availability
        const [drivers] = await connection.query(
          "SELECT * FROM warriors WHERE id = ? AND status = 'active' FOR UPDATE",
          [driverId]
        );
        if (drivers.length === 0) throw new Error("Driver not available");

        const [activeRide] = await connection.query(
          "SELECT id FROM rides WHERE driver_id = ? AND status IN ('accepted','in-progress','picked-up')",
          [driverId]
        );
        if (activeRide.length > 0) throw new Error("Driver already on a ride");

        const otp = generateOTP();

        await connection.query(
          `UPDATE rides 
           SET driver_id = ?, status = 'accepted', otp = ?, otp_verified = FALSE, updated_at = NOW()
           WHERE id = ?`,
          [driverId, otp, rideId]
        );

        await connection.commit();

        // Notify rider
        const [rider] = await connection.query(
          "SELECT socket_id FROM users WHERE id = ?",
          [ride.user_id]
        );
        if (rider[0]?.socket_id) {
          io.to(rider[0].socket_id).emit("rideAccepted", {
            rideId,
            driver: {
              id: driverId,
              name: drivers[0].full_name,
              phone: drivers[0].phone,
            },
            pickupLocation: { lat: ride.pickup_lat, lng: ride.pickup_lng },
            otp,
            estimatedArrival: Math.floor(Math.random() * 10) + 5,
          });
        }

        socket.emit("rideAcceptedConfirmation", { success: true, rideId, otp });
      } catch (err) {
        await connection.rollback();
        console.error(err);
        socket.emit("error", err.message);
      } finally {
        connection.release();
      }
    });

    // ------------------- VERIFY OTP (socket) -------------------
    socket.on("verifyOtp", async (data) => {
      const { rideId, otp, role } = data; // role: 'user' or 'driver'
      try {
        const [rides] = await db.query("SELECT * FROM rides WHERE id = ?", [rideId]);
        if (rides.length === 0) return socket.emit("error", "Ride not found");
        const ride = rides[0];
        if (ride.status !== "accepted")
          return socket.emit("error", `Ride cannot be started (status: ${ride.status})`);
        if (ride.otp !== otp) return socket.emit("error", "Invalid OTP");

        await db.query(
          "UPDATE rides SET otp_verified = TRUE, status = 'in-progress', updated_at = NOW() WHERE id = ?",
          [rideId]
        );

        // Notify both parties
        const [rider] = await db.query("SELECT socket_id FROM users WHERE id = ?", [ride.user_id]);
        const [driver] = await db.query("SELECT socket_id FROM warriors WHERE id = ?", [ride.driver_id]);

        if (rider[0]?.socket_id) io.to(rider[0].socket_id).emit("otpVerified", { rideId });
        if (driver[0]?.socket_id) io.to(driver[0].socket_id).emit("otpVerified", { rideId });

        socket.emit("otpVerifiedConfirmation", { success: true, rideId, status: "in-progress" });
      } catch (err) {
        console.error(err);
        socket.emit("error", err.message);
      }
    });

    // ------------------- START RIDE (driver picks up) -------------------
    socket.on("startRide", async (data) => {
      const { rideId, driverId } = data;
      try {
        const [rides] = await db.query(
          "SELECT * FROM rides WHERE id = ? AND driver_id = ?",
          [rideId, driverId]
        );
        if (rides.length === 0) return socket.emit("error", "Ride not found or not authorized");
        const ride = rides[0];
        if (ride.status !== "in-progress") return socket.emit("error", "Ride not ready to start");
        if (!ride.otp_verified) return socket.emit("error", "OTP not verified");

        await db.query(
          "UPDATE rides SET status = 'picked-up', pickup_time = NOW(), updated_at = NOW() WHERE id = ?",
          [rideId]
        );

        const [rider] = await db.query("SELECT socket_id FROM users WHERE id = ?", [ride.user_id]);
        if (rider[0]?.socket_id) {
          io.to(rider[0].socket_id).emit("rideStarted", { rideId, message: "Driver has picked you up" });
        }
        socket.emit("rideStartedConfirmation", { success: true, rideId, status: "picked-up" });
      } catch (err) {
        console.error(err);
        socket.emit("error", err.message);
      }
    });

    // ------------------- COMPLETE RIDE -------------------
    socket.on("completeRide", async (data) => {
      const { rideId, driverId } = data;
      try {
        const [rides] = await db.query(
          "SELECT * FROM rides WHERE id = ? AND driver_id = ?",
          [rideId, driverId]
        );
        if (rides.length === 0) return socket.emit("error", "Ride not found");
        const ride = rides[0];
        if (ride.status !== "picked-up") return socket.emit("error", "Ride cannot be completed");

        await db.query(
          "UPDATE rides SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?",
          [rideId]
        );

        const [rider] = await db.query("SELECT socket_id FROM users WHERE id = ?", [ride.user_id]);
        if (rider[0]?.socket_id) io.to(rider[0].socket_id).emit("rideCompleted", { rideId });

        socket.emit("rideCompletedConfirmation", { success: true, rideId });
      } catch (err) {
        console.error(err);
        socket.emit("error", err.message);
      }
    });

    // ------------------- TRACKING (send driver location to rider) -------------------
    socket.on("send_location", async (data) => {
      const { rideId, driverLocation } = data; // driverLocation: { lat, lng }
      try {
        const [rides] = await db.query("SELECT user_id, dropoff_lat, dropoff_lng FROM rides WHERE id = ?", [rideId]);
        if (rides.length === 0) return;
        const ride = rides[0];

        const [rider] = await db.query("SELECT socket_id FROM users WHERE id = ?", [ride.user_id]);
        if (!rider[0]?.socket_id) return;

        // Simple ETA calculation (example using geolib – install geolib if needed)
        const geolib = require("geolib");
        const distanceToDrop = geolib.getDistance(
          { latitude: driverLocation.lat, longitude: driverLocation.lng },
          { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }
        );
        const avgSpeedKmh = 40;
        const etaMinutes = (distanceToDrop / 1000 / avgSpeedKmh) * 60;

        io.to(rider[0].socket_id).emit("estimatedTimeToDrop", {
          estimatedTimeToDrop: etaMinutes.toFixed(2) + " mins",
          driverLocation,
        });
      } catch (err) {
        console.error(err);
      }
    });

    // ------------------- EMERGENCY ALERT -------------------
    socket.on("emergencyAlert", async (data) => {
      const { userType, userId, location } = data;
      try {
        let user = null;
        if (userType === "rider") {
          const [rows] = await db.query("SELECT name, phone FROM users WHERE id = ?", [userId]);
          user = rows[0];
        } else if (userType === "driver") {
          const [rows] = await db.query("SELECT full_name AS name, phone FROM warriors WHERE id = ?", [userId]);
          user = rows[0];
        }
        if (!user) return;

        // In a real app, you would fetch admin socket IDs from an admin table.
        // For simplicity, we emit to all connected admins (you can implement an admin registration event).
        // Here we just log and emit to a special room "admins".
        io.to("admins").emit("emergencyNotification", {
          userType,
          userId,
          name: user.name,
          phone: user.phone,
          location,
          message: `Emergency alert from ${userType}`,
        });
        socket.emit("emergencySent", { success: true });
      } catch (err) {
        console.error(err);
        socket.emit("error", "Failed to send emergency alert");
      }
    });

    // ------------------- DISCONNECT -------------------
    socket.on("disconnect", async () => {
      console.log(`Socket disconnected: ${socket.id}`);
      try {
        await db.query("UPDATE users SET socket_id = NULL WHERE socket_id = ?", [socket.id]);
        await db.query("UPDATE warriors SET socket_id = NULL WHERE socket_id = ?", [socket.id]);
      } catch (err) {
        console.error(err);
      }
    });
  });

  return io;
};