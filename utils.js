// utils.js
const crypto = require("crypto");
const fs = require("fs-extra");
const fetch = (url, options) =>
  import("node-fetch").then(({ default: fetch }) => fetch(url, options));

// --- Hashing & Canonicalization ---
const canonicalize = (s) =>
  String(s || "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const hashJobDescription = (jd) =>
  crypto.createHash("sha256").update(canonicalize(jd || ""), "utf8").digest("hex");

async function sha256File(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// --- De-identification ---
function deidentify(text, candidate) {
  let t = String(text || "");
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL>");
  t = t.replace(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3}\)?|\d{3})[\s-]?\d{3}[\s-]?\d{4}/g, "<PHONE>");
  t = t.replace(/https?:\/\/(www\.)?linkedin\.com\/[^\s)]+/gi, "<LINKEDIN>");
  if (candidate?.name) {
    const parts = String(candidate.name).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    for (const p of parts) {
      if (p.length >= 2) {
        const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        t = t.replace(re, "<NAME>");
      }
    }
  }
  return t;
}

// --- Certificate Helpers ---
const issuersKnown = [
  "Amazon Web Services","AWS","Google Cloud","GCP","Microsoft","Microsoft Learn","Azure",
  "Coursera","edX","Udemy","Udacity","Simplilearn","LinkedIn Learning",
  "Oracle","Cisco","Red Hat","HashiCorp","Snowflake","Databricks",
  "ISACA","PMI","Scrum Alliance","Atlassian","ServiceNow","Salesforce","Meta","IBM"
];
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function guessIssuer(text) {
  if (!text) return "Unknown";
  const t = " " + norm(text) + " ";
  for (const name of issuersKnown) {
    const n = " " + norm(name) + " ";
    if (t.includes(n)) return name;
  }
  if (/\baws\b|amazon web services/i.test(text)) return "AWS";
  if (/\bgoogle cloud\b|\bgcp\b/i.test(text)) return "Google Cloud";
  if (/\bazure\b|microsoft (certified|learn)/i.test(text)) return "Microsoft";
  if (/\bcoursera\b/i.test(text)) return "Coursera";
  if (/\bsimplilearn\b/i.test(text)) return "Simplilearn";
  if (/\blinked?in\s+learning\b/i.test(text)) return "LinkedIn Learning";
  if (/\bsalesforce\b/i.test(text)) return "Salesforce";
  if (/\bdatabricks\b/i.test(text)) return "Databricks";
  if (/\bsnowflake\b/i.test(text)) return "Snowflake";
  if (/\bhashicorp\b/i.test(text)) return "HashiCorp";
  if (/\bpmi\b|\bproject management institute\b/i.test(text)) return "PMI";
  if (/\bisaca\b/i.test(text)) return "ISACA";
  if (/\bred hat\b/i.test(text)) return "Red Hat";
  if (/\boracle\b/i.test(text)) return "Oracle";
  if (/\bmeta\b|facebook/i.test(text)) return "Meta";
  if (/\bservice\s*now\b/i.test(text)) return "ServiceNow";
  return "Unknown";
}
function extractCredentialIds(text) {
  const ids = new Set();
  (text.match(/\b[A-Z0-9][A-Z0-9\-]{7,20}\b/gi) || []).forEach((m) => ids.add(m));
  (text.match(/\b(cert(id|ificate)?|credential|license|no\.?)\s*[:#]?\s*([A-Z0-9\-]{6,})\b/gi) || []).forEach((m) => {
    const hit = m.split(/[:#]\s*/).pop();
    if (hit) ids.add(hit.trim());
  });
  return Array.from(ids);
}
function extractVerifyUrls(text) {
  const urls = new Set();
  (text.match(/\bhttps?:\/\/[^\s)]+/gi) || []).forEach((u) => urls.add(u.replace(/[)>.,]+$/, "")));
  return Array.from(urls);
}

// --- Network Helpers ---
const RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 5);
const BASE_DELAY_MS = Number(process.env.GEMINI_BASE_DELAY_MS || 800);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.floor(ms * (0.5 + Math.random()));

async function fetchWithRetry(url, init, parseJson = true) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        if (RETRY_STATUS.has(res.status) && attempt <= RETRIES) {
          const delay = jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
          await sleep(delay);
          continue;
        }
        const text = await res.text().catch(() => "");
        const err = new Error(`API request failed (${res.status})${text ? `: ${text}` : ""}`);
        err.status = res.status;
        throw err;
      }
      return parseJson ? res.json() : res.text();
    } catch (e) {
      if (attempt <= RETRIES) {
        const delay = jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
}

// --- Meeting Helpers ---
function toIcsDate(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function buildICS({ uid, startISO, endISO, title, joinUrl, organizerName, organizerEmail, attendeeName, attendeeEmail, method = "REQUEST", description = "" }) {
  const CRLF = "\r\n";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//IntelliHire//Meeting Scheduler//EN",
    "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(startISO)}`, `DTEND:${toIcsDate(endISO)}`,
    `SUMMARY:${(title || "Interview").replace(/\r?\n/g," ")}`,
    `DESCRIPTION:${description ? description.replace(/\r?\n/g,"\\n")+"\\n\\n" : ""}Join Video Call:\\n${joinUrl}`,
    `LOCATION:${joinUrl}`,
    `ORGANIZER;CN=${(organizerName || "Recruiter").replace(/\r?\n/g," ")}:mailto:${organizerEmail || "no-reply@intellihire.local"}`,
    `ATTENDEE;CN=${(attendeeName||"Candidate").replace(/\r?\n/g," ")};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendeeEmail || "candidate@example.com"}`,
    "STATUS:CONFIRMED", "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR", ""
  ];
  return lines.join(CRLF);
}

// --- File System Helper ---
async function deleteFileIfExists(p) {
  try { if (p && (await fs.pathExists(p))) await fs.remove(p); } catch (e) {
    console.warn("Delete file failed:", p, e.message);
  }
}

module.exports = {
  canonicalize,
  hashJobDescription,
  sha256File,
  deidentify,
  guessIssuer,
  extractCredentialIds,
  extractVerifyUrls,
  fetchWithRetry,
  sleep,
  jitter,
  toIcsDate,
  buildICS,
  deleteFileIfExists // <-- Make sure this is exported
};