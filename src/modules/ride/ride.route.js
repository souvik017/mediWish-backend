const express = require('express');
const router = express.Router();
const rideController = require('./ride.controller');

router.get('/find-drivers', rideController.findNearbyDrivers);
router.post('/book', rideController.bookRide);
router.put('/accept/:rideId', rideController.acceptRide);
router.post('/verify-otp', rideController.verifyOtp);
router.get('/tracking/:rideId', rideController.getTracking);
router.post('/start/:rideId', rideController.startRide);
router.post('/complete/:rideId', rideController.completeRide);

module.exports = router;