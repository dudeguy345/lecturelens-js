// Replaces {{name}} placeholders in a single pass. Inserted values are never
// re-scanned, so a transcript that happens to contain "{{...}}" can't inject
// into the template. Unknown placeholders are left as-is.
export function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match
  );
}

// Removes a surrounding ```json ... ``` fence if the model added one anyway.
export function stripCodeFences(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.slice(t.indexOf("\n") + 1);
    const end = t.lastIndexOf("```");
    if (end !== -1) t = t.slice(0, end);
  }
  return t.trim();
}
