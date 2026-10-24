// LectureLens server
// Serves the web UI from ./public and exposes two JSON endpoints that call Gemini:
//   POST /api/study-guide  -> full study guide (summary, notes, concepts, quiz)
//   POST /api/explain      -> simpler re-explanation of one concept

import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GeminiClient, GeminiError } from "./src/gemini.js";
import { fillTemplate } from "./src/util.js";
import { validateExplanation, validateStudyGuide } from "./src/validate.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_TRANSCRIPT_CHARS = 500_000; // ~6+ hours of speech
const GOALS = new Set(["quick_recap", "exam_review", "deep_dive"]);

const apiKey = process.env.GEMINI_API_KEY?.trim() || "";
const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
const port = Number(process.env.PORT) || 3000;
const mockMode = process.env.MOCK_MODE === "1" || process.argv.includes("--mock") || !apiKey;

// Load prompt templates once at startup so a missing file fails fast.
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const guideTemplate = read("prompts/v3_study_guide_json.txt");
const explainTemplate = read("prompts/explain_simpler.txt");
const sampleGuide = JSON.parse(read("data/sample_output.json"));

const gemini = new GeminiClient(apiKey, model);
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(ROOT, "public")));
app.use("/api", (req, res, next) => {
  res.on("finish", () => console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
  next();
});

const str = (v) => (typeof v === "string" ? v.trim() : "");

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model, mock_mode: mockMode });
});

app.post("/api/study-guide", async (req, res) => {
  const body = req.body ?? {};
  const transcript = str(body.transcript);
  const course = str(body.course_name) || "(not specified)";
  const goal = GOALS.has(body.study_goal) ? body.study_goal : "exam_review";
  const n = Number.parseInt(body.num_questions, 10);
  const numQuestions = Number.isNaN(n) ? 5 : Math.min(15, Math.max(3, n));

  if (!transcript) return res.status(400).json({ error: "Please paste or upload a transcript." });
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return res.status(413).json({ error: "That transcript is too long. Try one lecture at a time." });
  }

  if (mockMode) return res.json({ ...sampleGuide, _mock: true });

  const prompt = fillTemplate(guideTemplate, {
    course_name: course,
    study_goal: goal,
    num_questions: numQuestions,
    transcript,
  });

  try {
    res.json(await gemini.generateJson(prompt, validateStudyGuide));
  } catch (err) {
    handleError(res, err, "study-guide");
  }
});

app.post("/api/explain", async (req, res) => {
  const body = req.body ?? {};
  const term = str(body.term);
  const definition = str(body.definition);
  const course = str(body.course_name) || "(not specified)";
  if (!term) return res.status(400).json({ error: "Missing the concept to explain." });

  if (mockMode) {
    return res.json({
      simple_explanation: `(Mock mode) ${term} explained in plain words. Add a GEMINI_API_KEY to .env to get real explanations.`,
      analogy: "Like a recipe card: it tells the cook exactly what to make and how.",
      check_question: `In one sentence, what problem does ${term} solve?`,
      check_answer: "Answers will vary; compare yours to the definition above.",
      _mock: true,
    });
  }

  const prompt = fillTemplate(explainTemplate, { course_name: course, term, definition });
  try {
    res.json(await gemini.generateJson(prompt, validateExplanation));
  } catch (err) {
    handleError(res, err, "explain");
  }
});

function handleError(res, err, label) {
  if (err instanceof GeminiError) {
    console.error(`[${label}] ${err.message}`);
    return res.status(err.httpStatus).json({ error: err.message });
  }
  console.error(`[${label}] unexpected error:`, err);
  res.status(500).json({ error: "Internal server error." });
}

// Malformed JSON bodies and other errors from express itself.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "That transcript is too long. Try one lecture at a time." });
  }
  console.error("[server] unhandled:", err);
  res.status(500).json({ error: "Internal server error." });
});

app
  .listen(port, () => {
    console.log(`LectureLens running at http://localhost:${port}`);
    console.log(mockMode ? "MOCK MODE: returning sample data (no GEMINI_API_KEY set)" : `Using Gemini model: ${model}`);
  })
  .on("error", (err) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Set PORT in .env to change it.`
        : `Could not start server: ${err.message}`
    );
    process.exit(1);
  });
