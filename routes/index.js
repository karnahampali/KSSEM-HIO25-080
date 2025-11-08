// routes/index.js
const express = require("express");
const router = express.Router();
const path = require("path");

const authRoutes = require("./auth");
const adminRoutes = require("./admin");
const candidateRoutes = require("./candidate"); // <-- [NEW] Import

// --- API Routes ---
router.use("/auth", authRoutes);
router.use("/", adminRoutes);       // e.g., /candidates, /analyze
router.use("/", candidateRoutes);   // <-- [NEW] Use the routes

// --- HTML Route ---
// Serve the main index.html file
router.get("/", (req, res) => {
  // Use path.resolve to go "up one level" from /routes to the project root
  res.sendFile(path.resolve(__dirname, "..", "public", "index.html"));
});

module.exports = router;