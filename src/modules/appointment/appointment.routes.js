// modules/appointment/appointment.routes.js
const router = require('express').Router();
const appointmentController = require('./appointment.controller');

// Single endpoint for both join and auto-create
router.post('/join', appointmentController.joinAppointment);

// Optional: End call and cleanup
router.post('/end', appointmentController.endAppointment);

module.exports = router;