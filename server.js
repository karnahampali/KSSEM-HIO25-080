// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");

const allRoutes = require("./routes"); // Imports routes/index.js
const { globalErrorHandler } = require("./middleware/errorHandler");
const { closeTransport } = require("./mail/mail");

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// --- Middleware ---
app.use(cors({ origin: true, credentials: true })); // TODO: Restrict origin in production
app.use(express.json({ limit: "10mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 },
  })
);

// --- Static Files ---
app.use(
  "/uploads",
  express.static("uploads", {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if ([".pdf", ".png", ".jpg", ".jpeg", ".txt", ".ics"].includes(ext)) {
        res.setHeader("Content-Disposition", "inline");
      }
    },
  })
);
app.use(express.static("public"));

// --- Main App Routes ---
// Connects all routes from the /routes folder
app.use("/", allRoutes);

// --- Error Handling ---
// Handles all errors from catchAsync
app.use(globalErrorHandler);

// --- Graceful Shutdown ---
process.on("SIGINT", async () => { try { await closeTransport(); } finally { process.exit(0); } });
process.on("SIGTERM", async () => { try { await closeTransport(); } finally { process.exit(0); } });

// --- Start Server ---
app.listen(PORT, () =>
  console.log(`✅ Server running at http://localhost:${PORT} · Engine: AI (Gemini)`)
);