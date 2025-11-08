// ai-analyzer.js
const db = require("./db");
const utils = require("./utils");
const { readFileContent } = require("./file-parser");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs-extra"); // <-- THIS IS THE FIX

// --- Constants ---
const ENGINE = "ai"; // Gemini
const ANALYSIS_VERSION = Number(process.env.ANALYSIS_VERSION || 9);
const API_KEY = process.env.GEMINI_API_KEY || "";
if (!API_KEY) console.error("❌ GEMINI_API_KEY not set in .env");
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${API_KEY}`;
const GEMINI_SEED = Number(process.env.GEMINI_SEED || 0);

// --- Scoring Helpers ---
function normalizeScore(n) {
  let v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v <= 1 && v >= 0) v = v * 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}
function normalizeSection(s) { return { score: normalizeScore(s?.score), details: typeof s?.details === "string" ? s.details : "—" }; }
const clamp0to100 = (n) => { const x = Number.isFinite(+n) ? +n : 0; return Math.max(0, Math.min(100, x)); };
function computeOverall(skill, exp, cert) { const s = clamp0to100(skill), e = clamp0to100(exp), c = clamp0to100(cert); return Math.round(s * 0.5 + e * 0.35 + c * 0.15); }
function tierFromOverall(s) { return s >= 85 ? "Top" : s >= 70 ? "Strong" : s >= 50 ? "Average" : "Weak"; }
function certSortKey({ issuer, credentialIds, verifyUrls }) {
  const domain = (verifyUrls[0] || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  const idPrefix = (credentialIds[0] || "").slice(0, 4).toUpperCase();
  return `${issuer || "Unknown"}|${domain || "-"}|${idPrefix || "-"}`;
}

// --- [UPDATED] Input Building (Optimized & Safer) ---
async function buildCandidateInputs(candidate) {
  const skills = utils.canonicalize(utils.deidentify(candidate.otherSkillsText || "N/A", {}));
  let resumeHash = "d41d8cd98f00b204e9800998ecf8427e"; // default empty hash
  let resume = "No resume provided.";

  // --- Process Resume ---
  if (candidate.resumeFile && candidate.resumeFile.path) {
    try {
      // These can run in parallel
      const [resumeRaw, resumeHashBuffer] = await Promise.all([
        readFileContent(candidate.resumeFile),
        fs.readFile(candidate.resumeFile.path) // Read buffer for hashing
      ]);
      
      resume = utils.canonicalize(utils.deidentify(resumeRaw, {}));
      resumeHash = crypto.createHash("sha256").update(resumeHashBuffer).digest("hex");
    } catch (e) {
      console.error(`Failed to process resume ${candidate.resumeFile.path}: ${e.message}`);
      resume = "Failed to read resume.";
    }
  }

  let certHashes = [];
  let certificateSummaryText = "No certificates provided.";
  let certificateLocals = [];

  // --- Process Certificates (Optimized) ---
  if (candidate.certificates?.length) {
    
    const certProcessingPromises = candidate.certificates.map(async (cert) => {
      try {
        const [textRaw, fileBuffer] = await Promise.all([
           readFileContent(cert),
           fs.readFile(cert.path) // Read buffer for hashing
        ]);
        
        const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        const text = utils.canonicalize(utils.deidentify(textRaw, {}));
        const issuer = utils.guessIssuer(text);
        const credentialIds = utils.extractCredentialIds(text);
        const verifyUrls = utils.extractVerifyUrls(text);
        const fileName = cert.name || path.basename(cert.path);
        
        return {
          fileHash,
          detailedData: { fileName, issuer, credentialIds, verifyUrls }
        };
      } catch (e) {
        console.error(`Failed to process cert ${cert.path}: ${e.message}`);
        return null; // Return null on failure
      }
    });

    // Run all certificate processing jobs in parallel
    const processedCerts = (await Promise.all(certProcessingPromises)).filter(Boolean); // Filter out nulls
    
    certHashes = processedCerts.map(c => c.fileHash).sort();
    const detailed = processedCerts.map(c => c.detailedData);

    const sortedForUI = detailed.sort((a, b) => certSortKey(a).localeCompare(certSortKey(b)));
    certificateLocals = sortedForUI.map((r) => ({
      fileName: r.fileName,
      issuer: r.issuer,
      credentialIds: r.credentialIds,
      verifyUrls: r.verifyUrls,
    }));
    
    if(sortedForUI.length > 0) {
      certificateSummaryText = sortedForUI
        .map(
          (r, i) =>
            `Certificate ${i + 1}:\n  Issuer: ${r.issuer}\n  Credential IDs: ${
              r.credentialIds.length ? r.credentialIds.join(", ") : "—"
            }\n  Verify URLs: ${r.verifyUrls.length ? r.verifyUrls.join(", ") : "—"}`
        )
        .join("\n\n");
    }
  }
  
  return { resume, skills, resumeHash, certHashes, certificateSummaryText, certificateLocals };
}


function digestForInputs({ jd, skills, resumeHash, certHashes }) {
  const payload = JSON.stringify({
    v: ANALYSIS_VERSION,
    jd: utils.canonicalize(jd).toLowerCase(),
    skills: utils.canonicalize(skills).toLowerCase(),
    resumeHash,
    certHashes: (certHashes || []).slice(),
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

// --- Gemini API Call ---
async function aiScoreRaw({ jd, resume, skills, certificateSummaryText }) {
  const systemPrompt =
    "You are an expert hiring manager. Analyze strictly against the job description. " +
    "Return JSON ONLY that matches the schema exactly. Scores must be integers 0-100. " +
    "Use this rubric: skillMatch=50%, experienceMatch=35%, certificationValue=15%.";

  const userQuery = `
--- JOB DESCRIPTION ---
${utils.canonicalize(jd)}

--- INPUT (IDENTITY-FREE) ---
Skills (free text): ${skills}

--- RESUME TEXT ---
${resume || "N/A"}

--- CERTIFICATES (structured) ---
${certificateSummaryText}
`;

  const responseSchema = {
    type: "object",
    properties: {
      rankingTier: { type: "string" },
      overallScore: { type: "number" },
      skillMatch: { type: "object", properties: { score: { type: "number" }, details: { type: "string" } }, required: ["score","details"] },
      experienceMatch: { type: "object", properties: { score: { type: "number" }, details: { type: "string" } }, required: ["score","details"] },
      certificationValue: { type: "object", properties: { score: { type: "number" }, details: { type: "string" } }, required: ["score","details"] },
      pros: { type: "array", items: { type: "string" } },
      cons: { type: "array", items: { type: "string" } },
      certificateChecks: {
        type: "array", items: {
          type: "object",
          properties: {
            fileName: { type: "string" },
            issuer: { type: "string" },
            credentialIds: { type: "array", items: { type: "string" } },
            verifyUrls: { type: "array", items: { type: "string" } }
          },
          required: ["fileName","issuer","credentialIds","verifyUrls"]
        }
      }
    },
    required: ["rankingTier","overallScore","skillMatch","experienceMatch","certificationValue","pros","cons","certificateChecks"]
  };

  if (!API_KEY) throw new Error("Missing GEMINI_API_KEY.");

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    system_instruction: { parts: [{ text: systemPrompt }] },
    generation_config: {
      temperature: 0, top_p: 0, top_k: 1, candidate_count: 1,
      seed: GEMINI_SEED,
      response_mime_type: "application/json",
      response_schema: responseSchema,
    },
  };
  const apiData = await utils.fetchWithRetry(
    API_URL,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    true
  );
  const jsonText =
    apiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
    apiData?.content?.parts?.[0]?.text || null;
  if (!jsonText) throw new Error("AI did not return valid JSON content.");
  const cleaned = jsonText.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  return JSON.parse(cleaned);
}

// --- Main Analysis Function ---
async function analyzeAndCacheCandidate({ candidate, jobDescription, jdHash, allCandidates }) {
  const { resume, skills, resumeHash, certHashes, certificateSummaryText, certificateLocals } =
    await buildCandidateInputs(candidate);

  const cache = await db.loadCache();
  const key = digestForInputs({ jd: jobDescription, skills, resumeHash, certHashes });

  let parsed;
  if (cache.entries[key] && cache.entries[key].version === ANALYSIS_VERSION) {
    parsed = cache.entries[key].raw;
  } else {
    parsed = await aiScoreRaw({ jd: jobDescription, resume, skills, certificateSummaryText });
    cache.entries[key] = { version: ANALYSIS_VERSION, raw: parsed, savedAt: new Date().toISOString() };
    await db.saveCache(cache); // Safe
  }

  const skillMatch = normalizeSection(parsed.skillMatch);
  const experienceMatch = normalizeSection(parsed.experienceMatch);
  const certificationValue = normalizeSection(parsed.certificationValue);
  const overallScore = computeOverall(skillMatch.score, experienceMatch.score, certificationValue.score);
  const rankingTier = tierFromOverall(overallScore);

  const result = {
    rankingTier,
    overallScore,
    skillMatch,
    experienceMatch,
    certificationValue,
    pros: Array.isArray(parsed.pros) ? parsed.pros : [],
    cons: Array.isArray(parsed.cons) ? parsed.cons : [],
    certificateChecks: certificateLocals,
  };

  if (!candidate.analyses) candidate.analyses = {};
  candidate.analyses[jdHash] = {
    analysisResult: result,
    jobDescriptionPreview: utils.canonicalize(jobDescription).slice(0, 150) + (jobDescription.length > 150 ? "..." : ""),
    analyzedAt: new Date().toISOString(),
    version: ANALYSIS_VERSION,
    engine: ENGINE,
    digest: key,
  };
  await db.saveCandidates(allCandidates); // Safe
  return result;
}

module.exports = {
  analyzeAndCacheCandidate,
  normalizeScore, // Export for admin route
  ENGINE,
  ANALYSIS_VERSION
};