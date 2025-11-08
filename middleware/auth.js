// middleware/auth.js
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const BCRYPT_ROUNDS = 12; // Added bcrypt rounds

async function verifyPassword(plain) {
  if (ADMIN_PASSWORD_HASH) {
    try { return await bcrypt.compare(plain, ADMIN_PASSWORD_HASH); }
    catch { return false; }
  }
  if (!ADMIN_PASSWORD) return false;
  // Fallback for plain text password (not recommended)
  const a = Buffer.from(String(plain));
  const b = Buffer.from(String(ADMIN_PASSWORD));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ message: "Not authenticated" });
}

// --- [NEW] ---
// Middleware to protect routes that require a logged-in candidate
function requireCandidate(req, res, next) {
  if (req.session?.candidateId) return next();
  return res.status(401).json({ message: "Not authenticated" });
}
// --- [END NEW] ---

module.exports = {
  verifyPassword,
  requireAdmin,
  requireCandidate // <-- Export the new function
};