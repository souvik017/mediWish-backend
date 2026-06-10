const express = require('express');
const router = express.Router();
const rideController = require('./ride.controller');

router.get('/find-drivers', rideController.findNearbyDrivers);
router.post('/book', rideController.bookRide);
router.get('/details/:rideId?', rideController.getRideDetails);
router.get('/history/:userId', rideController.getUserRideHistory);
router.put('/accept/:rideId', rideController.acceptRide);
router.delete('/cancel', rideController.cancelRideWithoutId);  // For cancelling without rideId (searching state)
router.post('/cancel/:rideId?', rideController.cancelRideWithId);  // For cancelling with or without rideIdrouter.post('/verify-otp', rideController.verifyOtp);
router.get('/tracking/:rideId', rideController.getTracking);
router.post('/start/:rideId', rideController.startRide);
router.post('/complete/:rideId', rideController.completeRide);

module.exports = router;