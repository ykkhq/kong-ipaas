const IMPLICIT = new Set(['request', 'response', 'service_request', 'service_response', 'vault']);

/** "Get user #1" -> "GET_USER_1" (DataKit node name). */
export function upperSnake(label: string): string {
  const s = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!s) return 'NODE';
  return /^[0-9]/.test(s) ? `N_${s}` : s;
}

/** "Get user" -> "get_user" (jq input alias). */
export function lowerSnake(label: string): string {
  return upperSnake(label).toLowerCase();
}

export const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/** DataKit names are case-sensitive, so only the exact lowercase forms collide. */
export function isImplicitName(name: string): boolean {
  return IMPLICIT.has(name);
}

/** Allocates unique DataKit node names, suffixing collisions with _2, _3 … */
export class NameAllocator {
  private used = new Set<string>();
  take(base: string): string {
    let name = base;
    for (let i = 2; this.used.has(name) || isImplicitName(name); i++) name = `${base}_${i}`;
    this.used.add(name);
    return name;
  }
}
