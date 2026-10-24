// Thin wrapper around the Gemini REST API (generateContent).
// All provider-specific code lives here, so switching to another LLM vendor
// only means rewriting this file.

import { stripCodeFences } from "./util.js";

const GEMINI_HOST = "https://generativelanguage.googleapis.com";
const TIMEOUT_MS = 300_000; // long transcripts can take a minute or more

// An error that should be reported to the browser with a specific HTTP status.
export class GeminiError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export class GeminiClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async #callOnce(prompt) {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json", // ask Gemini for raw JSON
        temperature: 0.4,
      },
    };

    let res;
    try {
      res = await fetch(`${GEMINI_HOST}/v1beta/models/${this.model}:generateContent`, {
        method: "POST",
        // The key goes in a header, not the URL, so it doesn't end up in logs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err.name === "TimeoutError" ? "timed out" : err.cause?.code || err.message;
      throw new GeminiError(502, `Could not reach the Gemini API (${reason}).`);
    }

    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* handled below */
    }

    if (!res.ok) {
      let msg = `Gemini API returned HTTP ${res.status}`;
      if (data?.error?.message) msg += `: ${data.error.message}`;
      // Pass rate limits through so the UI can say "wait a minute".
      throw new GeminiError(res.status === 429 ? 429 : 502, msg);
    }
    if (!data) throw new GeminiError(502, "Gemini returned a response that was not JSON.");

    const candidate = data.candidates?.[0];
    if (!candidate) {
      const block = data.promptFeedback?.blockReason;
      throw new GeminiError(502, `Gemini returned no answer (${block ? `blocked: ${block}` : "no candidates"}).`);
    }

    // Skip "thinking" parts if the model includes them.
    const text = (candidate.content?.parts ?? [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    if (!text) {
      throw new GeminiError(502, `Gemini returned an empty answer (finishReason: ${candidate.finishReason ?? "unknown"}).`);
    }
    return text;
  }

  // Sends the prompt, parses and validates the JSON. If the model returns
  // invalid JSON or the wrong shape, it retries before giving up.
  async generateJson(prompt, validate, maxAttempts = 2) {
    let lastProblem = "output could not be used";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const raw = await this.#callOnce(prompt);
      try {
        const parsed = JSON.parse(stripCodeFences(raw));
        const problem = validate ? validate(parsed) : "";
        if (!problem) return parsed;
        lastProblem = `output did not match the schema (${problem})`;
      } catch {
        lastProblem = "output was not valid JSON";
      }
      console.error(`[gemini] attempt ${attempt} failed: ${lastProblem}`);
    }
    throw new GeminiError(502, `The AI's ${lastProblem}. Please try again.`);
  }
}
