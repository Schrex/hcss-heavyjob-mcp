/** HCSS Telematics read scope. Never request telematics:write. */
export const TELEMATICS_READ_SCOPE = "telematics:read";

/** Shown when the token's granted scope omits telematics:read, the token endpoint returns invalid_scope, or the equipment endpoint returns 403. */
export const TELEMATICS_SCOPE_ERROR = "The HCSS Client ID needs the telematics:read scope enabled in HCSS Credentials.";

/** Configured scope with telematics:read removed, so HeavyJob calls can proceed when HCSS rejects the combined scope. */
export function withoutTelematicsScope(scope: string): string {
  return scope.split(/\s+/).filter((s) => s && s !== TELEMATICS_READ_SCOPE).join(" ");
}

/**
 * Whether an OAuth token response grants `scope`.
 * RFC 6749: if the issued scope equals the requested scope, the server MAY omit the scope parameter.
 * An omitted value (undefined) therefore counts as granted. A present string is checked literally.
 */
export function grantedIncludes(granted: string | undefined, scope: string): boolean {
  if (granted === undefined) return true;
  return granted.split(/\s+/).filter(Boolean).includes(scope);
}
