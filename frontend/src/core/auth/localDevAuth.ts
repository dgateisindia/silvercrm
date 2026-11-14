/**
 * D-GATE Silver CRM — local development token provider.
 *
 * Development only. Never a production login system.
 *
 * - Tokens are supplied explicitly.
 * - Tokens remain in JavaScript memory.
 * - No localStorage, sessionStorage or cookies.
 * - No hardcoded credentials or example users.
 * - Production builds reject access.
 * - The CRM backend must validate every request.
 */

export class LocalDevAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalDevAuthError'
  }
}

export type LocalDevAuthSession = Readonly<{
  setToken: (token: string) => void
  getToken: () => Promise<string | null>
  clearToken: () => void
  hasToken: () => boolean
}>

function requireDevelopmentMode(): void {
  if (import.meta.env.DEV !== true) {
    throw new LocalDevAuthError(
      'Local development authentication is unavailable outside development mode.',
    )
  }
}

function validateToken(token: string): void {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token !== token.trim() ||
    /\s/.test(token)
  ) {
    throw new LocalDevAuthError(
      'A nonempty access token without whitespace is required.',
    )
  }
}

/**
 * Creates an isolated, in-memory developer token holder.
 *
 * Creating this object does not authenticate the user
 * and does not make a network request.
 *
 * Later, the getToken callback can be supplied to
 * the existing CRM API client factory in bearer mode.
 */
export function createLocalDevAuthSession(): LocalDevAuthSession {
  requireDevelopmentMode()

  let currentToken: string | null = null

  return Object.freeze({
    setToken(token: string): void {
      requireDevelopmentMode()
      validateToken(token)
      currentToken = token
    },

    async getToken(): Promise<string | null> {
      requireDevelopmentMode()
      return currentToken
    },

    clearToken(): void {
      requireDevelopmentMode()
      currentToken = null
    },

    hasToken(): boolean {
      requireDevelopmentMode()
      return currentToken !== null
    },
  })
}