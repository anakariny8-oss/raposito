module.exports = function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false });
  return res.status(200).json({ ok: true, service: "raposito-bot" });
};
