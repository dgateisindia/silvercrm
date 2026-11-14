/** Outbound Clerk invitations. Never use a browser/public API key here. */
export interface ProviderInvite { readonly id: string; readonly status: 'pending'; }
export interface StaffInvitationProvider {
  send(email: string): Promise<ProviderInvite>;
  revoke(invitationId: string): Promise<void>;
}
export interface ClerkInvitationOptions {
  readonly secretKey: string;
  readonly redirectUrl: string;
  readonly fetcher?: typeof fetch;
}

function validProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^inv_[A-Za-z0-9_-]{6,120}$/.test(value);
}

export function createClerkInvitationProvider(options: ClerkInvitationOptions): StaffInvitationProvider {
  if (!options || typeof options.secretKey !== 'string' ||
      !/^sk_(?:test|live)_[A-Za-z0-9_-]{10,}$/.test(options.secretKey))
    throw Error('CRM_INVITE_CLERK_SECRET_INVALID');
  let redirect: URL;
  try { redirect = new URL(options.redirectUrl); }
  catch { throw Error('CRM_INVITE_REDIRECT_INVALID'); }
  if (redirect.protocol !== 'https:' || !redirect.hostname || redirect.username ||
      redirect.password || redirect.hash) throw Error('CRM_INVITE_REDIRECT_INVALID');
  const fetcher = options.fetcher ?? fetch;
  const base = 'https://api.clerk.com/v1/invitations';

  async function call(url: string, payload?: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(7000),
        redirect: 'error',
      });
    } catch { throw Error('CRM_CLERK_INVITATION_DELIVERY_UNCERTAIN'); }
    if (!response.ok) throw Error('CRM_CLERK_INVITATION_PROVIDER_REJECTED');
    let text: string;
    try { text = await response.text(); } catch { throw Error('CRM_CLERK_INVITATION_DELIVERY_UNCERTAIN'); }
    if (text.length > 16384) throw Error('CRM_CLERK_INVITATION_INVALID_RESPONSE');
    try { return JSON.parse(text) as unknown; }
    catch { throw Error('CRM_CLERK_INVITATION_INVALID_RESPONSE'); }
  }

  return Object.freeze({
    async send(email: string): Promise<ProviderInvite> {
      const raw = await call(base, {
        email_address: email,
        redirect_url: redirect.toString(),
        notify: true,
        ignore_existing: false,
        expires_in_days: 7,
      });
      if (!raw || typeof raw !== 'object') throw Error('CRM_CLERK_INVITATION_INVALID_RESPONSE');
      const value = raw as Record<string, unknown>;
      if (!validProviderId(value.id) || value.status !== 'pending' ||
          value.email_address !== email) throw Error('CRM_CLERK_INVITATION_INVALID_RESPONSE');
      return { id: value.id, status: 'pending' };
    },
    async revoke(invitationId: string): Promise<void> {
      if (!validProviderId(invitationId)) throw Error('CRM_CLERK_INVITATION_ID_INVALID');
      const raw = await call(`${base}/${encodeURIComponent(invitationId)}/revoke`);
      if (!raw || typeof raw !== 'object' ||
          (raw as Record<string, unknown>).id !== invitationId ||
          (raw as Record<string, unknown>).status !== 'revoked')
        throw Error('CRM_CLERK_INVITATION_INVALID_RESPONSE');
    },
  });
}

/** This factory is deliberately lazy and can only activate after deployment approval. */
export function configuredClerkInvitationProvider(): StaffInvitationProvider {
  if (process.env.NODE_ENV !== 'production' || process.env.AUTH_MODE !== 'platform' ||
      process.env.CRM_STAFF_INVITATIONS_ENABLED !== 'true')
    throw Error('CRM_STAFF_INVITATIONS_DISABLED');
  return createClerkInvitationProvider({
    secretKey: process.env.CRM_CLERK_BACKEND_SECRET_KEY ?? '',
    redirectUrl: process.env.CRM_STAFF_INVITE_REDIRECT_URL ?? '',
  });
}
