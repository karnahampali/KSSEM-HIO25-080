// db.js
const fs = require("fs-extra");
const path = require("path");
const { deleteFileIfExists } = require("./utils"); // <-- Import helper

// --- Folder/File Setup ---
fs.ensureDirSync("uploads/resumes");
fs.ensureDirSync("uploads/certificates");
fs.ensureDirSync("uploads/ics");
fs.ensureDirSync("data");

const DATA_PATH = "data/candidates.json";
const CACHE_PATH = "data/ai_cache.json";
const MEETINGS_PATH = "data/meetings.json";

if (!fs.existsSync(DATA_PATH)) fs.writeJSONSync(DATA_PATH, { candidates: [] }, { spaces: 2 });
if (!fs.existsSync(CACHE_PATH)) fs.writeJSONSync(CACHE_PATH, { entries: {} }, { spaces: 2 });
if (!fs.existsSync(MEETINGS_PATH)) fs.writeJSONSync(MEETINGS_PATH, { meetings: [] }, { spaces: 2 });

// --- Load Functions ---
const loadCandidates = async () => (await fs.readJSON(DATA_PATH)).candidates;
const loadCache = async () => await fs.readJSON(CACHE_PATH);
const loadMeetings = async () => (await fs.readJSON(MEETINGS_PATH)).meetings;

// --- Atomic Save Queues (Fixes Race Conditions) ---
let candidateQueue = Promise.resolve();
let cacheQueue = Promise.resolve();
let meetingQueue = Promise.resolve();

const saveCandidates = (c) => {
  candidateQueue = candidateQueue
    .catch(() => {}) // Ignore previous errors, just chain the next save
    .finally(() => fs.writeJSON(DATA_PATH, { candidates: c }, { spaces: 2 }));
  return candidateQueue;
};
const saveCache = (obj) => {
  cacheQueue = cacheQueue
    .catch(() => {})
    .finally(() => fs.writeJSON(CACHE_PATH, obj, { spaces: 2 }));
  return cacheQueue;
};
const saveMeetings = (m) => {
  meetingQueue = meetingQueue
    .catch(() => {})
    .finally(() => fs.writeJSON(MEETINGS_PATH, { meetings: m }, { spaces: 2 }));
  return meetingQueue;
};

// --- [NEW] Data Helpers ---

// Strips password hash and other sensitive data before sending to client
function getClientSafeCandidate(candidate) {
  if (!candidate) return null;
  // Create a copy and remove passwordHash
  const { passwordHash, ...safeCandidate } = candidate;
  // Ensure file paths are URLs
  return {
    ...safeCandidate,
    resumeFile: candidate.resumeFile ? {
      filename: candidate.resumeFile.filename,
      url: candidate.resumeFile.urlPath, // Use urlPath for client
    } : null,
    certificates: (candidate.certificates || []).map(cert => ({
      name: cert.name,
      url: cert.urlPath // Use urlPath for client
    }))
  };
}

// Full candidate deletion logic
async function removeCandidateAndData(candidateId) {
  const candidates = await loadCandidates();
  const idx = candidates.findIndex((c) => c.id === candidateId);
  if (idx === -1) return { removed: false, reason: "Not found" };
  const c = candidates[idx];
  
  // Delete associated files
  await deleteFileIfExists(c?.resumeFile?.path);
  if (Array.isArray(c?.certificates)) {
    for (const cert of c.certificates) {
      await deleteFileIfExists(cert?.path);
    }
  }

  // Clear AI cache entries for this candidate
  try {
    const cache = await loadCache();
    const digests = Object.values(c.analyses || {}).map((a) => a?.digest).filter(Boolean);
    if (digests.length) {
      for (const d of digests) {
        delete cache.entries[d];
      }
      await saveCache(cache); // Safe
    }
  } catch (e) { console.warn("Cache cleanup warning:", e.message); }
  
  // Remove candidate from DB
  candidates.splice(idx, 1);
  await saveCandidates(candidates); // Safe
  return { removed: true };
}
// --- [END NEW] ---

module.exports = {
  loadCandidates,
  loadCache,
  loadMeetings,
  saveCandidates,
  saveCache,
  saveMeetings,
  getClientSafeCandidate, // <-- Export new function
  removeCandidateAndData  // <-- Export new function
};