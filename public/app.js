// LectureLens front end. Talks to the C++ server at /api/*.
// All AI text is inserted with textContent (via el()), never innerHTML.

const $ = (sel) => document.querySelector(sel);

const GOAL_LABELS = { quick_recap: "Quick recap", exam_review: "Exam review", deep_dive: "Deep dive" };
const LOADING_MESSAGES = [
  "Reading the transcript…",
  "Finding the lecture's structure…",
  "Pulling out key concepts…",
  "Writing practice questions…",
  "Checking the format…",
];

const state = {
  guide: null,
  course: "",
  goal: "exam_review",
  answers: {},        // quiz question index -> chosen option index
  explanations: {},   // concept index -> explanation JSON
  flashIndex: 0,
  flashFlipped: false,
  activeTab: "overview",
};

// ---------- small DOM helper ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------- transcript helpers ----------
function formatTimestamp(raw) {
  // "00:01:02.500" or "00:01:02,500" or "01:02.500" -> "1:02" / "1:01:02"
  const parts = raw.trim().replace(",", ".").split(":").map(Number);
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  s = Math.floor(s);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Turns .srt / .vtt subtitle files into "timestamp + text" lines and drops duplicates.
function cleanSubtitles(text) {
  if (!text.includes("-->")) return text;
  const out = [];
  let lastText = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) || /^(NOTE|STYLE|Kind:|Language:)/.test(line)) continue;
    if (line.includes("-->")) {
      out.push(formatTimestamp(line.split("-->")[0]));
      continue;
    }
    const cleaned = line.replace(/<[^>]+>/g, "").trim();
    if (cleaned && cleaned !== lastText) {
      out.push(cleaned);
      lastText = cleaned;
    }
  }
  // Remove timestamps that ended up with no text after them.
  return out.filter((l, i) => !(/^\d+:\d{2}(:\d{2})?$/.test(l) && (i + 1 >= out.length || /^\d+:\d{2}(:\d{2})?$/.test(out[i + 1])))).join("\n");
}

function updateTranscriptStats() {
  const text = $("#transcript").value.trim();
  if (!text) {
    $("#transcript-stats").textContent = "No transcript yet.";
    return;
  }
  const words = text.split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 140)); // ~140 spoken words per minute
  $("#transcript-stats").textContent = `${words.toLocaleString()} words · roughly a ${minutes}-minute lecture`;
}

// ---------- API ----------
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the LectureLens server. Is it still running?");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    if (res.status === 429) throw new Error("The Gemini free tier rate limit was hit. Wait a minute and try again.");
    throw new Error(data?.error || `Server error (${res.status}).`);
  }
  return data;
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const h = await res.json();
    const pill = $("#status-pill");
    pill.hidden = false;
    if (h.mock_mode) {
      pill.textContent = "Mock mode";
      pill.classList.add("warn");
      pill.title = "No GEMINI_API_KEY set; returning sample data.";
    } else {
      pill.textContent = h.model;
    }
  } catch { /* ignore */ }
}

// ---------- generate ----------
let loadingTimer = null;

function setLoading(on) {
  $("#loading").hidden = !on;
  $("#generate-btn").disabled = on;
  $("#generate-btn").textContent = on ? "Generating…" : "Generate study guide";
  clearInterval(loadingTimer);
  if (!on) return;
  const start = Date.now();
  $("#loading-msg").textContent = LOADING_MESSAGES[0];
  $("#elapsed").textContent = "0s";
  loadingTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - start) / 1000);
    $("#elapsed").textContent = `${secs}s`;
    $("#loading-msg").textContent = LOADING_MESSAGES[Math.min(Math.floor(secs / 8), LOADING_MESSAGES.length - 1)];
  }, 1000);
}

function showFormError(msg) {
  const box = $("#form-error");
  box.textContent = msg;
  box.hidden = !msg;
}

async function onGenerate(event) {
  event.preventDefault();
  showFormError("");
  const transcript = $("#transcript").value.trim();
  if (transcript.split(/\s+/).length < 50) {
    showFormError("Please paste a transcript of at least a few paragraphs.");
    $("#transcript").focus();
    return;
  }
  state.course = $("#course").value.trim();
  state.goal = document.querySelector('input[name="goal"]:checked').value;

  setLoading(true);
  try {
    const guide = await api("/api/study-guide", {
      course_name: state.course,
      study_goal: state.goal,
      num_questions: Number($("#num-questions").value),
      transcript,
    });
    showGuide(guide);
  } catch (err) {
    showFormError(err.message);
  } finally {
    setLoading(false);
  }
}

// ---------- results ----------
function showGuide(guide) {
  state.guide = guide;
  state.answers = {};
  state.explanations = {};
  state.flashIndex = 0;
  state.flashFlipped = false;

  $("#input-view").hidden = true;
  $("#result-view").hidden = false;
  $("#mock-banner").hidden = !guide._mock;
  $("#result-title").textContent = guide.title;
  $("#result-meta").textContent = [state.course || null, GOAL_LABELS[state.goal]].filter(Boolean).join(" · ");

  renderOverview();
  renderNotes();
  renderConcepts();
  renderQuiz();
  renderFlashcards();
  selectTab("overview");
  window.scrollTo({ top: 0 });
}

function selectTab(name) {
  state.activeTab = name;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
}

function renderOverview() {
  const g = state.guide;
  $("#panel-overview").replaceChildren(
    el("div", { class: "stack" },
      el("div", { class: "card block" },
        el("h2", {}, "Summary"),
        el("p", { class: "summary" }, g.summary)),
      el("div", { class: "card block" },
        el("h2", {}, "Key takeaways"),
        el("ol", { class: "takeaways" }, g.key_takeaways.map((t) => el("li", {}, t)))),
      el("div", { class: "stats" },
        el("span", { class: "stat" }, el("b", {}, g.sections.length), "sections"),
        el("span", { class: "stat" }, el("b", {}, g.key_concepts.length), "concepts"),
        el("span", { class: "stat" }, el("b", {}, g.quiz.length), "quiz questions"))));
}

function sectionId(i) { return `section-${i}`; }

function renderNotes() {
  $("#panel-notes").replaceChildren(
    el("div", { class: "stack" },
      state.guide.sections.map((s, i) =>
        el("article", { class: "card section-card", id: sectionId(i) },
          el("div", { class: "section-head" },
            s.start_time ? el("span", { class: "time" }, s.start_time) : null,
            el("h3", {}, s.title)),
          el("ul", {}, s.bullets.map((b) => el("li", {}, b)))))));
}

function goToSection(title) {
  const i = state.guide.sections.findIndex((s) => s.title.trim().toLowerCase() === String(title).trim().toLowerCase());
  selectTab("notes");
  if (i < 0) return;
  const card = document.getElementById(sectionId(i));
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1500);
}

function renderConcepts() {
  $("#panel-concepts").replaceChildren(
    el("div", { class: "concept-grid" },
      state.guide.key_concepts.map((c, i) => conceptCard(c, i))));
}

function conceptCard(c, i) {
  const box = el("div", { class: "explain-slot" });
  const btn = el("button", { class: "btn btn-ghost btn-small", type: "button" }, "Explain it simpler");
  btn.addEventListener("click", async () => {
    if (state.explanations[i]) return;
    btn.disabled = true;
    btn.textContent = "Thinking…";
    try {
      const ex = await api("/api/explain", { term: c.term, definition: c.definition, course_name: state.course });
      state.explanations[i] = ex;
      box.replaceChildren(explainBox(ex));
      btn.remove();
    } catch (err) {
      box.replaceChildren(el("p", { class: "alert" }, err.message));
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
  return el("article", { class: "card concept" },
    el("h3", {}, c.term),
    el("p", {}, c.definition),
    c.example ? el("p", { class: "example" }, el("b", {}, "In the lecture: "), c.example) : null,
    box,
    btn);
}

function explainBox(ex) {
  return el("div", { class: "explain-box" },
    el("p", {}, ex.simple_explanation),
    el("p", {}, el("b", {}, "Analogy: "), ex.analogy),
    el("details", {},
      el("summary", {}, `Check yourself: ${ex.check_question}`),
      el("p", {}, ex.check_answer)));
}

// ---------- quiz ----------
const LETTERS = ["A", "B", "C", "D", "E", "F"];

function renderQuiz() {
  const quiz = state.guide.quiz;
  const answered = Object.keys(state.answers).length;
  const correct = quiz.filter((q, i) => state.answers[i] === q.answer_index).length;

  const scorebar = el("div", { class: "scorebar" },
    el("span", {}, `${answered} of ${quiz.length} answered · ${correct} correct`),
    el("div", { class: "progress", "aria-hidden": "true" }, el("div", { style: `width:${(answered / quiz.length) * 100}%` })));

  const questions = quiz.map((q, qi) => {
    const chosen = state.answers[qi];
    const done = chosen !== undefined;
    const options = q.options.map((opt, oi) => {
      let cls = "option";
      if (done && oi === q.answer_index) cls += " correct";
      else if (done && oi === chosen) cls += " wrong";
      return el("button", {
        class: cls, type: "button", disabled: done,
        onclick: () => { state.answers[qi] = oi; renderQuiz(); },
      }, el("span", { class: "letter" }, LETTERS[oi] || "•"), el("span", {}, opt));
    });
    const feedback = done
      ? el("p", { class: "feedback" },
          chosen === q.answer_index ? el("b", { class: "good" }, "Correct. ") : el("b", { class: "bad" }, "Not quite. "),
          q.explanation,
          q.related_section ? el("span", {}, " ", el("button", { class: "linkish", type: "button", onclick: () => goToSection(q.related_section) }, "Review this section")) : null)
      : null;
    return el("article", { class: "card question" },
      el("div", { class: "qnum" }, `Question ${qi + 1}`),
      el("h3", {}, q.question),
      el("div", { class: "options" }, options),
      feedback);
  });

  const children = [scorebar, ...questions];
  if (answered === quiz.length) children.push(quizResults(correct));
  $("#panel-quiz").replaceChildren(el("div", { class: "stack" }, children));
}

function quizResults(correct) {
  const quiz = state.guide.quiz;
  const missed = [...new Set(quiz
    .filter((q, i) => state.answers[i] !== q.answer_index && q.related_section)
    .map((q) => q.related_section))];
  const pct = Math.round((correct / quiz.length) * 100);
  return el("div", { class: "card results" },
    el("h2", {}, `You scored ${correct}/${quiz.length} (${pct}%)`),
    missed.length
      ? [el("p", { class: "muted" }, "Review these sections before trying again:"),
         el("ul", {}, missed.map((t) => el("li", {}, el("button", { class: "linkish", type: "button", onclick: () => goToSection(t) }, t))))]
      : el("p", { class: "muted" }, "Perfect score. Try flashcards to lock it in."),
    el("p", {}, el("button", { class: "btn btn-ghost btn-small", type: "button", onclick: () => { state.answers = {}; renderQuiz(); } }, "Retry quiz")));
}

// ---------- flashcards ----------
function renderFlashcards() {
  const cards = state.guide.key_concepts;
  if (!cards.length) {
    $("#panel-flashcards").replaceChildren(el("p", { class: "muted" }, "No concepts to study."));
    return;
  }
  const c = cards[state.flashIndex];
  const card = el("button", {
    class: `flashcard${state.flashFlipped ? " flipped" : ""}`, type: "button",
    "aria-label": state.flashFlipped ? `Definition of ${c.term}. Click to flip back.` : `${c.term}. Click to see the definition.`,
    onclick: () => { state.flashFlipped = !state.flashFlipped; renderFlashcards(); },
  },
    el("div", { class: "flash-inner" },
      el("div", { class: "face front" }, el("span", { class: "tag" }, "Term"), el("h3", {}, c.term)),
      el("div", { class: "face back" }, el("span", { class: "tag" }, "Definition"), el("p", {}, c.definition))));

  $("#panel-flashcards").replaceChildren(
    el("div", { class: "flash-wrap" },
      card,
      el("div", { class: "flash-controls" },
        el("button", { class: "btn btn-ghost", type: "button", onclick: () => moveFlash(-1) }, "← Prev"),
        el("span", { class: "counter" }, `${state.flashIndex + 1} / ${cards.length}`),
        el("button", { class: "btn btn-ghost", type: "button", onclick: () => moveFlash(1) }, "Next →")),
      el("p", { class: "hint" }, "Click the card or press Space to flip. Arrow keys move between cards.")));
}

function moveFlash(delta) {
  const n = state.guide.key_concepts.length;
  state.flashIndex = (state.flashIndex + delta + n) % n;
  state.flashFlipped = false;
  renderFlashcards();
}

// ---------- export ----------
function toMarkdown() {
  const g = state.guide;
  const lines = [`# ${g.title}`, ""];
  if (state.course) lines.push(`*${state.course} · ${GOAL_LABELS[state.goal]}*`, "");
  lines.push("## Summary", "", g.summary, "", "## Key takeaways", "");
  g.key_takeaways.forEach((t) => lines.push(`- ${t}`));
  lines.push("", "## Notes", "");
  g.sections.forEach((s) => {
    lines.push(`### ${s.start_time ? `[${s.start_time}] ` : ""}${s.title}`, "");
    s.bullets.forEach((b) => lines.push(`- ${b}`));
    lines.push("");
  });
  lines.push("## Key concepts", "");
  g.key_concepts.forEach((c) => {
    lines.push(`**${c.term}**: ${c.definition}`);
    if (c.example) lines.push(`  *In the lecture:* ${c.example}`);
    lines.push("");
  });
  lines.push("## Practice quiz", "");
  g.quiz.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.question}`);
    q.options.forEach((o, oi) => lines.push(`   ${LETTERS[oi]}. ${o}`));
    lines.push("");
  });
  lines.push("### Answer key", "");
  g.quiz.forEach((q, i) => lines.push(`${i + 1}. ${LETTERS[q.answer_index]}: ${q.explanation}`));
  return lines.join("\n");
}

function downloadMarkdown() {
  const blob = new Blob([toMarkdown()], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const name = (state.guide.title || "study-guide").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const a = el("a", { href: url, download: `${name || "study-guide"}.md` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wiring ----------
$("#guide-form").addEventListener("submit", onGenerate);
$("#transcript").addEventListener("input", updateTranscriptStats);
$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("#transcript").value = cleanSubtitles(await file.text());
  updateTranscriptStats();
  e.target.value = "";
});
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
$("#new-btn").addEventListener("click", () => {
  $("#result-view").hidden = true;
  $("#input-view").hidden = false;
  window.scrollTo({ top: 0 });
});
$("#export-btn").addEventListener("click", downloadMarkdown);
document.addEventListener("keydown", (e) => {
  if (state.activeTab !== "flashcards" || $("#result-view").hidden) return;
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "ArrowRight") moveFlash(1);
  else if (e.key === "ArrowLeft") moveFlash(-1);
  else if (e.key === " ") {
    e.preventDefault();
    state.flashFlipped = !state.flashFlipped;
    renderFlashcards();
  }
});

checkHealth();
updateTranscriptStats();
