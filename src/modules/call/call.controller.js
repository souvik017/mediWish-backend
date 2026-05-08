const callService = require("./call.service");

exports.startCall = async (req, res) => {
  try {
    const { callerId, receiverId, channelName } = req.body;

    if (!callerId || !receiverId || !channelName) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const token = await callService.startCall({
      callerId,
      receiverId,
      channelName,
      callerName,
    });

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
};