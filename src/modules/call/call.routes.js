const router = require("express").Router();
const ctrl = require("./call.controller");

router.post("/start", ctrl.startCall);

module.exports = router;