// Schema checks for the model's output. The UI depends on these shapes, so
// anything else is rejected and the request is retried.
// Each validator returns "" if valid, otherwise a short description of the problem.

const isString = (v) => typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateStudyGuide(g) {
  if (!isObject(g)) return "top level is not an object";
  for (const key of ["title", "summary"]) {
    if (!isString(g[key])) return `missing string field '${key}'`;
  }
  for (const key of ["key_takeaways", "sections", "key_concepts", "quiz"]) {
    if (!Array.isArray(g[key])) return `missing array field '${key}'`;
  }
  for (const s of g.sections) {
    if (!isObject(s) || !isString(s.title) || !Array.isArray(s.bullets)) {
      return "a section is missing its title or bullets";
    }
  }
  for (const c of g.key_concepts) {
    if (!isObject(c) || !isString(c.term) || !isString(c.definition)) {
      return "a key concept is missing its term or definition";
    }
  }
  if (g.quiz.length === 0) return "quiz is empty";
  for (const q of g.quiz) {
    if (!isObject(q) || !isString(q.question) || !Array.isArray(q.options) || q.options.length < 2) {
      return "a quiz question is missing its text or options";
    }
    if (!Number.isInteger(q.answer_index)) return "a quiz question has no integer answer_index";
    if (q.answer_index < 0 || q.answer_index >= q.options.length) {
      return "a quiz answer_index is out of range";
    }
  }
  return "";
}

export function validateExplanation(e) {
  if (!isObject(e)) return "top level is not an object";
  for (const key of ["simple_explanation", "analogy", "check_question", "check_answer"]) {
    if (!isString(e[key])) return `missing string field '${key}'`;
  }
  return "";
}
