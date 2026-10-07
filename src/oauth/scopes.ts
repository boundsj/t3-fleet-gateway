export const READ_SCOPE = 'fleet:read';
export const OPERATE_SCOPE = 'fleet:operate';
export const SUPPORTED_SCOPES = [READ_SCOPE, OPERATE_SCOPE] as const;
export type Scope = (typeof SUPPORTED_SCOPES)[number];

/** What the operator grants on the approval page. Operate implies read. */
export type AccessChoice = 'read' | 'operate';

export function scopesForChoice(choice: AccessChoice): Scope[] {
  return choice === 'operate' ? [READ_SCOPE, OPERATE_SCOPE] : [READ_SCOPE];
}

function isScope(value: string): value is Scope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(value);
}

/** Parse a space-delimited scope parameter. Returns undefined when it names an unknown scope. */
export function parseScope(value: string | null | undefined): Scope[] | undefined {
  const parts = (value ?? '').split(' ').filter((part) => part.length > 0);
  if (!parts.every(isScope)) return undefined;
  return SUPPORTED_SCOPES.filter((scope) => parts.includes(scope));
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(' ');
}
