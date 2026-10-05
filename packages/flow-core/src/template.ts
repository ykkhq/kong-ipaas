const PLACEHOLDER = /\{\{\{([\s\S]+?)\}\}\}|\{\{([\s\S]+?)\}\}/g;

export function hasPlaceholders(s: string): boolean {
  return new RegExp(PLACEHOLDER.source).test(s);
}

/**
 * Turns "http://x/users/{{ .req.query.id }}" into a jq string expression.
 * `{{ expr }}` is URI-encoded, `{{{ expr }}}` is inserted raw.
 */
export function templateToJq(template: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (m.index! > last) parts.push(JSON.stringify(template.slice(last, m.index)));
    parts.push(m[1] !== undefined ? `((${m[1].trim()}) | tostring)` : `((${m[2].trim()}) | tostring | @uri)`);
    last = m.index! + m[0].length;
  }
  if (last < template.length) parts.push(JSON.stringify(template.slice(last)));
  return parts.length ? parts.join(' + ') : '""';
}

/** A syntactically valid URL to use as the call node's static fallback. */
export function templateFallback(template: string): string {
  return template.replace(PLACEHOLDER, '_');
}
