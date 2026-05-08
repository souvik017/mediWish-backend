const router = require("express").Router();
const ctrl = require("./user.controller");

router.post("/register-token", ctrl.registerToken);

module.exports = router;