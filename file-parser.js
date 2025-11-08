// file-parser.js
const fs = require("fs-extra");
const path = require("path");
const sharp = require("sharp");
const { canonicalize } = require("./utils");

// Lazy load heavy dependencies
let tesseract = null;
let canvasLib = null;
let mammoth = null;
let pdfParse = null;
let pdfjs = null;

const MIN_TEXT_LEN = 80;
const OCR_MAX_PAGES = 10;
const OCR_LANG = "eng";

const preprocessImage = async (buffer) => {
  const MAX_SIDE = 2400;
  let img = sharp(buffer).ensureAlpha().removeAlpha().grayscale();
  const meta = await img.metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  const scale = longest > 0 ? Math.min(MAX_SIDE / longest, 3) : 1;
  if (scale > 1) img = img.resize({ width: Math.round((meta.width || 0) * scale) });
  return await img.normalize().sharpen(0.8).linear(1.2, -10).gamma(1.1).toFormat("png").toBuffer();
};

const readDocx = async (filePath) => {
  if (!mammoth) mammoth = require("mammoth");
  const res = await mammoth.extractRawText({ path: filePath });
  return canonicalize(res.value || "");
};
const readTxt = async (filePath) => {
  return canonicalize(await fs.readFile(filePath, "utf8"));
};

const readPdfTextLayer = async (filePath) => {
  try {
    if (!pdfParse) pdfParse = (await import("pdf-parse")).default;
    const buf = await fs.readFile(filePath);
    const data = await pdfParse(buf);
    return canonicalize(data?.text || "");
  } catch { return ""; }
};
const readPdfTextWithPdfjs = async (filePath) => {
  try {
    if (!pdfjs) pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    const buf = await fs.readFile(filePath);
    const data = new Uint8Array(buf);
    const pdfDoc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
    const pageCount = Math.min(pdfDoc.numPages || 0, OCR_MAX_PAGES);
    let text = "";
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      const pageText = (content.items || []).map((it) => it.str).join(" ");
      text += pageText + "\n\n";
    }
    return canonicalize(text);
  } catch { return ""; }
};
async function renderPdfPageToPng(pdfDoc, pageNum) {
  try {
    if (!canvasLib) canvasLib = require("@napi-rs/canvas");
  } catch (e) {
     throw new Error("canvas module not available for rasterization. Please run 'npm install @napi-rs/canvas'");
  }
  
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 3.0 });
  const { createCanvas } = canvasLib;
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  const raw = canvas.toBuffer("image/png");
  return await preprocessImage(raw);
};
async function ocrImageBuffer(buffer) {
  try {
    if (!tesseract) tesseract = require("tesseract.js");
  } catch(e) {
    throw new Error("Tesseract OCR not available. Install: npm i tesseract.js");
  }

  const pre = await preprocessImage(buffer);
  const { createWorker } = tesseract;
  const worker = await createWorker();
  try {
    await worker.loadLanguage(OCR_LANG);
    await worker.initialize(OCR_LANG);
    await worker.setParameters({
      tessedit_pageseg_mode: "3",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const { data } = await worker.recognize(pre);
    return canonicalize(data?.text || "");
  } finally {
    await worker.terminate();
  }
};
async function ocrPdfWithPdfjs(filePath) {
  if (!pdfjs) pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  const buf = await fs.readFile(filePath);
  const data = new Uint8Array(buf);
  const pdfDoc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const pageCount = Math.min(pdfDoc.numPages || 0, OCR_MAX_PAGES);
  let text = "";
  for (let i = 1; i <= pageCount; i++) {
    const img = await renderPdfPageToPng(pdfDoc, i);
    text += (await ocrImageBuffer(img)) + "\n\n";
  }
  return canonicalize(text);
};
async function readImageWithOCR(filePath) {
  const buffer = await fs.readFile(filePath);
  return await ocrImageBuffer(buffer);
};

// This is the main function exported to the rest of the app
async function readFileContent(file) {
  if (!file || !file.path) return "No file provided.";
  const ext = path.extname(file.path).toLowerCase();
  try {
    if (ext === ".pdf") {
      let text = await readPdfTextLayer(file.path);
      if (text && text.length >= MIN_TEXT_LEN) return text;
      let text2 = await readPdfTextWithPdfjs(file.path);
      if (text2 && text2.length >= Math.max(40, Math.floor(MIN_TEXT_LEN * 0.6))) return text2;
      try {
        const ocrText = await ocrPdfWithPdfjs(file.path);
        if (ocrText && ocrText.length >= 10) return ocrText;
      } catch (e) { console.error("OCR fallback failed:", e); }
      return "PDF appears to have no extractable text (even after OCR).";
    }
    if (ext === ".docx") return (await readDocx(file.path)) || "DOCX appears empty or unreadable.";
    if (ext === ".txt") return (await readTxt(file.path)) || "TXT appears empty.";
    if ([".png", ".jpg", ".jpeg"].includes(ext)) {
      const text = await readImageWithOCR(file.path);
      return text || "Image had no OCR-detectable text.";
    }
    return `Unsupported file type (${ext}). Try PDF, DOCX, TXT, PNG, or JPG.`;
  } catch (err) {
    console.error(`Failed to read file ${file.filename || "unknown"}:`, err);
    return `Could not read file: ${file.filename || "unknown"}. Type: ${ext}. Error: ${err.message}`;
  }
};

module.exports = {
  readFileContent
};