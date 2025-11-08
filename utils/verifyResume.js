const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const docxParser = require("docx-parser");
const { sha256 } = require("js-sha256");

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === ".docx") {
    return await new Promise((resolve, reject) => {
      docxParser.parseDocx(filePath, (data) => resolve(data));
    });
  }

  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }

  return "";
}

function detectAIGenerated(text) {
  const suspiciousPatterns = [
    /highly motivated/i,
    /seeking to leverage/i,
    /proven track record/i,
    /dynamic professional/i,
    /results-driven/i
  ];

  let score = 0;
  suspiciousPatterns.forEach(p => {
    if (p.test(text)) score += 1;
  });

  return score >= 3; // if 3+ patterns appear → likely generic / AI generated
}

function detectResumeHashDuplicate(text, allHashes) {
  const hash = sha256(text);
  return { hash, isDuplicate: allHashes.includes(hash) };
}

module.exports = {
  extractText,
  detectAIGenerated,
  detectResumeHashDuplicate,
};
