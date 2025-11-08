// routes/auth.js
const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const catchAsync = require("../middleware/catchAsync");
const { verifyPassword } = require("../middleware/auth");

const router = express.Router();
const BCRYPT_ROUNDS = 12;
const ADMIN_USER = process.env.ADMIN_USER || "";

// --- Admin Auth ---
// Fixed route from /admin/login to /login to match client
router.post("/login", catchAsync(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ message: "Username and password are required." });
  if (!ADMIN_USER) return res.status(500).json({ message: "Admin not configured." });
  if (username !== ADMIN_USER || !(await verifyPassword(password)))
    return res.status(401).json({ message: "Invalid credentials." });
  req.session.isAdmin = true;
  req.session.username = username;
  res.json({ success: true, username });
}));

router.get("/admin/whoami", (req, res) => {
  res.json({ authenticated: !!req.session?.isAdmin, username: req.session?.username || null });
});

router.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// --- [NEW] Candidate Auth ---
router.post("/candidate/signup", catchAsync(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ message: "Name, email, and password are required." });
  }

  const candidates = await db.loadCandidates();
  const lowerEmail = email.toLowerCase().trim();
  const existing = candidates.find(c => c.email === lowerEmail);

  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const newCandidate = {
    id: uuidv4(),
    name: name.trim(),
    email: lowerEmail,
    passwordHash, // Store the hash, not the plain password
    submittedAt: new Date().toISOString(),
    // Profile fields, initially empty
    linkedinUrl: null,
    otherSkillsText: null,
    resumeFile: null,
    certificates: [],
    analyses: {},
    quarantined: false,
    quarantinedAt: null,
    quarantineReason: null,
  };

  candidates.push(newCandidate);
  await db.saveCandidates(candidates);

  // Log them in immediately
  req.session.candidateId = newCandidate.id;

  res.status(201).json({
    success: true,
    message: "Account created successfully",
    candidate: db.getClientSafeCandidate(newCandidate) // Send safe data back
  });
}));

router.post("/candidate/login", catchAsync(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const candidates = await db.loadCandidates();
  const lowerEmail = email.toLowerCase().trim();
  const candidate = candidates.find(c => c.email === lowerEmail);

  if (!candidate) {
    // Use a generic error to prevent email enumeration
    return res.status(401).json({ message: "Invalid credentials." });
  }

  // Compare provided password with stored hash
  const match = await bcrypt.compare(password, candidate.passwordHash || "");
  if (!match) {
    return res.status(401).json({ message: "Invalid credentials." });
  }

  // Login success, set session
  req.session.candidateId = candidate.id;

  res.json({
    success: true,
    message: "Login successful",
    candidate: db.getClientSafeCandidate(candidate) // Send safe data
  });
}));

router.get("/candidate/whoami", catchAsync(async (req, res) => {
  if (!req.session?.candidateId) {
    return res.json({ authenticated: false, candidate: null });
  }

  const candidates = await db.loadCandidates();
  const candidate = candidates.find(c => c.id === req.session.candidateId);

  if (!candidate) {
    // Session is stale (e.g., user deleted), destroy it
    req.session.destroy(() => {});
    return res.json({ authenticated: false, candidate: null });
  }

  res.json({
    authenticated: true,
    candidate: db.getClientSafeCandidate(candidate) // Send safe data
  });
}));

router.post("/candidate/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});
// --- [END NEW] ---

module.exports = router;