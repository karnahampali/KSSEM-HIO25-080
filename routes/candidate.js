// routes/candidate.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { deleteFileIfExists } = require("../utils");
const { requireCandidate } = require("../middleware/auth");
const catchAsync = require("../middleware/catchAsync");

const router = express.Router();

// --- Multer Setup for File Uploads ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.fieldname === "resume") cb(null, "uploads/resumes");
      else cb(null, "uploads/certificates");
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
}).fields([{ name: "resume", maxCount: 1 }, { name: "certificates", maxCount: 10 }]);

// --- [NEW] Submit/Update Candidate Profile ---
// This route is now for UPDATING the logged-in user's profile
router.post("/submit", requireCandidate, upload, catchAsync(async (req, res) => {
  
  const { candidateName, linkedinUrl, otherSkillsText } = req.body;
  
  const candidates = await db.loadCandidates();
  const candidateIndex = candidates.findIndex(c => c.id === req.session.candidateId);
  
  if (candidateIndex === -1) {
    // This should not happen if requireCandidate middleware is used
    req.session.destroy(() => {}); // Log them out
    return res.status(404).json({ message: "Candidate account not found." });
  }
  
  const candidate = candidates[candidateIndex];

  // Update text fields
  candidate.name = candidateName || candidate.name;
  candidate.linkedinUrl = linkedinUrl; // Allow client to send empty string to clear it
  candidate.otherSkillsText = otherSkillsText; // Allow clearing

  // Handle new resume upload
  if (req.files?.resume?.[0]) {
    // Delete old resume if it exists
    if (candidate.resumeFile?.path) {
      await deleteFileIfExists(candidate.resumeFile.path);
    }
    // Set new resume
    candidate.resumeFile = {
      filename: req.files.resume[0].originalname,
      path: req.files.resume[0].path,
      urlPath: `/uploads/resumes/${req.files.resume[0].filename}`,
    };
  }

  // Handle new certificate uploads
  if (req.files?.certificates?.length) {
    // This logic appends new certificates to the existing ones
    const newCertificates = (req.files.certificates || []).map((f) => ({
      name: f.originalname,
      path: f.path,
      urlPath: `/uploads/certificates/${f.filename}`,
    }));
    candidate.certificates = (candidate.certificates || []).concat(newCertificates);
  }
  
  // Update the timestamp
  candidate.submittedAt = new Date().toISOString();
  
  // Save the updated candidate back into the array
  candidates[candidateIndex] = candidate;
  await db.saveCandidates(candidates);
  
  res.json({
    success: true,
    message: "Profile updated successfully",
    candidate: db.getClientSafeCandidate(candidate) // Send safe data back
  });
}));

// --- [NEW] Secure Route for Candidate to Get Their Meeting ---
router.get("/candidate/my-meeting", requireCandidate, catchAsync(async (req, res) => {
  const meetings = (await db.loadMeetings())
    .filter(m => m.candidateId === req.session.candidateId && m.status !== "cancelled")
    .sort((a,b) => new Date(b.startISO) - new Date(a.startISO));
  
  const m = meetings[0]; // Get the most recent active meeting
  
  if (!m) {
    return res.json({ meeting: null });
  }
  
  // Return only the data the client needs
  res.json({
    meeting: {
      title: m.title,
      startISO: m.startISO,
      durationMin: m.durationMin,
      videoUrl: m.videoUrl,
      icsUrl: m.icsUrl,
    }
  });
}));

module.exports = router;