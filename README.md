# LectureLens

Turn a long lecture transcript into a study guide you'll actually use: organized notes with timestamps, key concepts, an interactive practice quiz, and flashcards. Built for CS4680 (Prompt Engineering) at Cal Poly Pomona.

**Back end:** Node.js + Express
**AI:** Google Gemini API (`gemini-3.8-flash`, free tier)
**Front end:** HTML, CSS and vanilla JavaScript served by the same Express server

## The problem

Lecture recordings are long (the one used for testing runs over an hour), and rewatching them to study takes too much time. Auto-generated transcripts exist but are a wall of unpunctuated text. Students need the structure pulled out, the key ideas defined, and a way to test themselves.

## Features

- **Paste or upload** a transcript (`.txt`, `.srt`, `.vtt`). Subtitle files are cleaned automatically (timing lines become timestamps, duplicate caption lines are removed).
- **Study goal** (quick recap / exam review / deep dive) changes how detailed the output is.
- **Overview:** summary and key takeaways.
- **Notes:** sections in lecture order, each with the timestamp where it starts.
- **Key concepts:** term, definition, and how it appeared in the lecture, plus an **"Explain it simpler"** button that makes a second AI call for a plain-language explanation, an analogy, and a check-yourself question.
- **Practice quiz:** click to answer, instant feedback with explanations, a score, and **weak-spot review** that links missed questions back to the notes section to reread.
- **Flashcards:** flip cards built from the key concepts (keyboard: Space to flip, arrows to move).
- **Export** the whole guide as Markdown.
- **Mock mode** returns sample data with no API key, as a backup for live demos.

## How it works

```
Browser (public/)                 Node server                          Gemini API
-----------------                 -----------------                    ----------
form inputs  --POST /api/study-guide-->  fill prompt template  --generateContent-->
                                          (prompts/v3_*.txt)
render tabs  <------- JSON ---------   parse + validate JSON  <------ JSON text -----
                                          (retry once if invalid)
```

The server checks every response against the schema (required fields, 4 options per question, `answer_index` in range). If the model returns broken JSON or the wrong shape, it retries once before showing an error, so the UI never receives something it can't render.

## Prompt engineering

The prompt was developed in versions, following the same iterate-and-test process from Lecture 11. All versions are kept in `prompts/`.

| File | Pattern(s) | What changed |
|---|---|---|
| `v1_persona.txt` | Persona | First draft: "act as an experienced teaching assistant." Good content but different layout every run. |
| `v2_refined.txt` | Iterative Refinement | Asked the model to improve v1. Added a learning-coach role, definitions for each study goal, rules against invented facts, and handling for misheard words in auto-captions. |
| `v3_study_guide_json.txt` | Template + Few-Shot + Persona | Final version used by the app. Fixed JSON schema so the UI can parse it, per-goal size rules, and one example quiz question showing the expected difficulty and style. |
| `explain_simpler.txt` | Persona + Template | Second prompt for the "Explain it simpler" button: a patient tutor, a 4-sentence limit, an analogy, and a JSON output. |

How each pattern helps the app:

- **Persona** (TA / learning-science coach, then a patient tutor) sets the tone and focus: study-oriented notes rather than a generic summary, and beginner-friendly re-explanations.
- **Iterative Refinement** turned a vague first draft into a prompt with explicit rules, which removed invented facts and handled transcript errors like "Chibbe" meaning ChatGPT.
- **Template** (a fixed JSON schema) makes the output machine-readable and consistent between runs. Without it the tabs, quiz scoring and flashcards couldn't work.
- **Few-Shot** (one example question) shows the model what a good question looks like: tests understanding, has plausible wrong answers. It's marked "style reference only" so the model doesn't copy its content.

The code adds one more safeguard: placeholders are filled in a single pass, so a transcript that happens to contain `{{...}}` can't change the template.

## Setup

### 1. Get a free Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in (a personal Gmail works if your school account is blocked).
2. Click **Create API key** and copy it.

### 2. Add it to `.env`

```bash
cp .env.example .env
# then edit .env and paste your key after GEMINI_API_KEY=
```

`.env` is in `.gitignore`. Never commit your key.

### 3. Install and run

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Use `npm run dev` to restart automatically when you edit files.

No key yet? It starts in **mock mode** automatically and returns `data/sample_output.json`. You can also force it with `npm run mock`.

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{status, model, mock_mode}` |
| POST | `/api/study-guide` | `{course_name, study_goal, num_questions, transcript}` | study guide JSON (schema in `prompts/v3_study_guide_json.txt`) |
| POST | `/api/explain` | `{term, definition, course_name}` | `{simple_explanation, analogy, check_question, check_answer}` |

Errors come back as `{ "error": "message" }` with a 4xx/5xx status. A Gemini rate limit is passed through as 429 so the UI can say "wait a minute."

## Project structure

```
server.js               Express server, routes, input checks
src/
  gemini.js             Gemini REST call, JSON parsing, retry
  validate.js           schema checks for the model's output
  util.js               template filling, code-fence stripping
prompts/                every prompt version (v1 -> v3) + explain prompt
public/                 index.html, style.css, app.js
data/sample_output.json sample study guide (mock mode + UI development)
```

All Gemini-specific code is in `src/gemini.js`, so switching to another provider (OpenAI, a local model) means changing only that file.

## Demo tips

- Have a transcript ready in a text file before presenting.
- Generation takes 20 to 60 seconds for a full lecture. Talk through the prompt versions while it runs.
- If the network or the free-tier rate limit fails during the demo, restart with `npm run mock` to show the full UI.

## Future work

- Combine several lectures into one exam guide
- Upload audio or video and transcribe it automatically
- Save guides to a per-course library
- "Ask the lecture" chat that answers only from the transcript, with timestamps
- Deploy publicly (bonus): any Node host such as Render or Railway works; set `GEMINI_API_KEY` in the host's environment settings

## Notes

- On Gemini's free tier, Google may use inputs and outputs to improve its models. Don't paste private material.
- AI output can be wrong. Check important details against the lecture.
