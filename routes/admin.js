// routes/admin.js
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs-extra");
const db = require("../db");
const ai = require("../ai-analyzer");
const utils = require("../utils");
const { sendMail } = require("../mail/mail");
const { requireAdmin, verifyPassword } = require("../middleware/auth");
const catchAsync = require("../middleware/catchAsync");

const router = express.Router();

// --- Candidate Management ---
router.get("/candidates", requireAdmin, catchAsync(async (req, res) => {
  const candidates = await db.loadCandidates();
  const clientSafe = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email, // <-- [NEW] Show email to admin
    linkedinUrl: c.linkedinUrl,
    otherSkillsText: c.otherSkillsText,
    submittedAt: c.submittedAt,
    quarantined: !!c.quarantined,
    quarantinedAt: c.quarantinedAt || null,
    quarantineReason: c.quarantineReason || null,
    resumeFile: c.resumeFile ? { 
      filename: c.resumeFile.filename, 
      path: c.resumeFile.urlPath 
    } : null,
    certificates: (c.certificates || []).map((cert) => ({ 
      name: cert.name, 
      url: cert.urlPath 
    })),
    analyses: c.analyses ? Object.entries(c.analyses).map(([hash, data]) => ({
      hash,
      preview: data.jobDescriptionPreview || "Analysis",
      score: ai.normalizeScore(data.analysisResult?.overallScore || 0),
      version: data.version || 0,
      digest: data.digest || null,
    })) : [],
  }));
  res.json({ 
    candidates: clientSafe, 
    analysisVersion: ai.ANALYSIS_VERSION, 
    engine: ai.ENGINE 
  });
}));

router.post("/candidates/:id/quarantine", requireAdmin, catchAsync(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  const candidates = await db.loadCandidates();
  const c = candidates.find((x) => x.id === id);
  if (!c) return res.status(404).json({ message: "Candidate not found" });
  c.quarantined = true; c.quarantinedAt = new Date().toISOString();
  c.quarantineReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;
  await db.saveCandidates(candidates);
  res.json({ success: true, id, quarantined: true, quarantinedAt: c.quarantinedAt, reason: c.quarantineReason });
}));

router.post("/candidates/:id/unquarantine", requireAdmin, catchAsync(async (req, res) => {
  const { id } = req.params;
  const candidates = await db.loadCandidates();
  const c = candidates.find((x) => x.id === id);
  if (!c) return res.status(404).json({ message: "Candidate not found" });
  c.quarantined = false; c.quarantinedAt = null; c.quarantineReason = null;
  await db.saveCandidates(candidates);
  res.json({ success: true, id, quarantined: false });
}));

router.delete("/candidates/:id", requireAdmin, catchAsync(async (req, res) => {
  const { id } = req.params;
  const out = await db.removeCandidateAndData(id);
  if (!out.removed) return res.status(404).json({ message: out.reason || "Not found" });
  res.json({ success: true, id });
}));

// --- Analysis ---
router.post("/analyze", requireAdmin, catchAsync(async (req, res) => {
  const { candidateId, jobDescription } = req.body || {};
  if (!jobDescription) return res.status(400).json({ message: "Job description is required" });
  
  const jdHash = utils.hashJobDescription(jobDescription); // <-- Use utils
  
  const candidates = await db.loadCandidates();
  const candidate = candidates.find((c) => c.id === candidateId);
  
  if (!candidate) return res.status(404).json({ message: "Candidate not found" });
  if (candidate.quarantined) {
    return res.status(423).json({ message: "Candidate is quarantined...", quarantined: true, reason: candidate.quarantineReason || null });
  }
  
  // --- [NEW] Safety Check ---
  if (!candidate.resumeFile || !candidate.resumeFile.path) {
    return res.status(400).json({ message: "Candidate has not submitted a resume and cannot be analyzed." });
  }
  // --- [END NEW] ---

  const normalized = await ai.analyzeAndCacheCandidate({ candidate, jobDescription, jdHash, allCandidates: candidates });
  res.json(normalized);
}));

router.post("/analyze-all", requireAdmin, catchAsync(async (req, res) => {
  const { jobDescription } = req.body || {};
  if (!jobDescription) return res.status(400).json({ message: "Job description required" });
  
  const jdHash = utils.hashJobDescription(jobDescription); // <-- Use utils
  
  const candidates = await db.loadCandidates();
  const rankings = [];
  
  for (const candidate of candidates) {
    if (candidate.quarantined) {
      rankings.push({ id: candidate.id, name: candidate.name, score: null, rankingTier: "Quarantined", error: "Candidate is quarantined" });
      continue;
    }
    
    // --- [NEW] Safety Check ---
    if (!candidate.resumeFile || !candidate.resumeFile.path) {
       rankings.push({ id: candidate.id, name: candidate.name, score: null, rankingTier: "No Resume", error: "Candidate has no resume" });
       continue;
    }
    // --- [END NEW] ---

    try {
      const normalized = await ai.analyzeAndCacheCandidate({ candidate, jobDescription, jdHash, allCandidates: candidates });
      rankings.push({
        id: candidate.id, name: candidate.name,
        score: ai.normalizeScore(normalized.overallScore),
        overallScore: ai.normalizeScore(normalized.overallScore),
        rankingTier: normalized.rankingTier, error: null,
      });
    } catch (e) {
      rankings.push({ id: candidate.id, name: candidate.name, score: null, rankingTier: "Error", error: e?.message || "Failed" });
    }
  }
  
  rankings.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)); // Handle null scores
  res.json({ rankings, analysisVersion: ai.ANALYSIS_VERSION, engine: ai.ENGINE });
}));

// --- Meetings ---
router.post("/meetings", requireAdmin, catchAsync(async (req, res) => {
  const {
    candidateId, startISO, durationMin, endISO: endISOIn, title,
    description, organizerName, organizerEmail, candidateEmail, sendEmail,
  } = req.body || {};

  if (!candidateId || !startISO || !title) {
    return res.status(400).json({ message: "candidateId, startISO, and title are required." });
  }
  const candidates = await db.loadCandidates();
  const cand = candidates.find(c => c.id === candidateId);
  if (!cand) return res.status(404).json({ message: "Candidate not found" });

  const start = new Date(startISO);
  if (isNaN(start)) return res.status(400).json({ message: "Invalid startISO." });
  const end = endISOIn ? new Date(endISOIn) : new Date(start.getTime() + (Number(durationMin || 30) * 60 * 1000));
  if (isNaN(end)) return res.status(400).json({ message: "Invalid end time." });

  const mid = crypto.randomUUID();
  const room = `IntelliHire-${mid.replace(/-/g, "")}`;
  const videoUrl = `https://meet.jit.si/${room}`;
  const uid = `${mid}@intellihire.local`;
  
  // Use the email from the form, fall back to candidate's stored email
  const finalCandidateEmail = candidateEmail || cand.email || "candidate@example.com";
  
  const ics = utils.buildICS({
    uid, startISO: start.toISOString(), endISO: end.toISOString(), title,
    joinUrl: videoUrl,
    organizerName: organizerName || (process.env.FROM_NAME || "Recruiter"),
    organizerEmail: organizerEmail || (process.env.FROM_EMAIL || "no-reply@intellihire.local"),
    attendeeName: cand.name || "Candidate",
    attendeeEmail: finalCandidateEmail,
    description: description || "",
  });

  const icsFilename = `${mid}.ics`;
  const icsPath = path.join("uploads", "ics", icsFilename);
  await fs.writeFile(icsPath, ics, "utf8");
  const icsUrl = `/uploads/ics/${icsFilename}`;

  const meetings = await db.loadMeetings();
  const meeting = {
    id: mid, candidateId, title,
    description: description || "",
    startISO: start.toISOString(), endISO: end.toISOString(),
    durationMin: Math.round((end - start) / 60000),
    videoUrl, icsUrl,
    organizerName: organizerName || (process.env.FROM_NAME || "Recruiter"),
    organizerEmail: organizerEmail || (process.env.FROM_EMAIL || "no-reply@intellihire.local"),
    candidateEmail: finalCandidateEmail,
    status: "scheduled", createdAt: new Date().toISOString(),
  };
  meetings.push(meeting);
  await db.saveMeetings(meetings);

  let mail = { attempted: false, recipients: [] };
  if (sendEmail) {
    const recipients = [
      finalCandidateEmail,
      (organizerEmail || process.env.FROM_EMAIL || "").trim(),
    ].filter(Boolean).filter(e => e.includes('@')); // Basic email validation

    if (recipients.length === 0) {
      return res.status(400).json({ message: "sendEmail=true but no valid candidate or organizer email provided" });
    }

    const whenPretty = start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    const subject = `[Interview] ${title} — ${whenPretty}`;
    const html = `
      <p>Hi ${cand.name || "Candidate"},</p>
      <p>You have an interview scheduled.</p>
      <ul>
        <li><strong>Title:</strong> ${title}</li>
        <li><strong>When:</strong> ${whenPretty}</li>
        <li><strong>Join link:</strong> <a href="${videoUrl}">${videoUrl}</a></li>
      </ul>
      <p>The calendar invite is attached.</p>
    `;
    const text = `Interview scheduled.\nTitle: ${title}\nWhen: ${whenPretty}\nJoin: ${videoUrl}\n`;

    try {
      const info = await sendMail({
        to: recipients, subject, text, html, ics,
        organizerName: organizerName || (process.env.FROM_NAME || "Recruiter"),
        organizerEmail: organizerEmail || process.env.FROM_EMAIL,
      });
      mail = { attempted: true, recipients, messageId: info.messageId };
    } catch (e) {
      console.error("✉️ sendMail failed:", e);
      return res.status(502).json({ message: `Email send failed: ${e.message || e}` });
    }
  }
  res.json({ meeting, mail });
}));

router.get("/meetings", requireAdmin, catchAsync(async (req, res) => {
  const { candidateId } = req.query;
  if (!candidateId) return res.status(400).json({ message: "candidateId is required" });
  const meetings = (await db.loadMeetings())
    .filter(m => m.candidateId === candidateId && m.status !== "cancelled")
    .sort((a,b) => new Date(b.startISO) - new Date(a.startISO));
  res.json({ meetings });
}));

router.post("/meetings/:id/cancel", requireAdmin, catchAsync(async (req, res) => {
  const { id } = req.params;
  const meetings = await db.loadMeetings();
  const m = meetings.find(x => x.id === id);
  if (!m) return res.status(404).json({ message: "Meeting not found" });
  if (m.status === "cancelled") return res.json({ ok: true, meeting: m });
  m.status = "cancelled";
  m.cancelledAt = new Date().toISOString();
  await db.saveMeetings(meetings);
  res.json({ ok: true, meeting: m });
}));

// --- System ---
router.post("/admin/reset", requireAdmin, catchAsync(async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ message: "Password required" });
  const ok = await verifyPassword(password);
  if (!ok) return res.status(403).json({ message: "Invalid admin password" });

  for (const d of ["uploads/resumes", "uploads/certificates", "uploads/ics"]) {
    try { await fs.emptyDir(d); } catch (e) { console.warn("emptyDir failed:", d, e.message); }
  }
  // Reset all data files
  await db.saveCandidates([]);
  await db.saveCache({ entries: {} });
  await db.saveMeetings([]);
  
  res.json({ success: true, message: "Portal reset to a clean state." });
}));

module.exports = router;