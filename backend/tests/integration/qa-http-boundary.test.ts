import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createCrmApp } from '../../src/app';
import { createDevSessionStore } from '../../src/core/auth/devSessionVerifier';
import { createDevIdentityStore } from '../../src/core/auth/devIdentityResolver';

// Never use production sessions or real users in this test.
// Local in-memory identity stores exercise the actual CRM app auth boundary.
const sessions = createDevSessionStore();
const identities = createDevIdentityStore();
const tokens: Record<string, string> = {};
let server: Server;
let base = '';

async function request(who: string | null, extraHeaders: Record<string,string> = {}) {
  const headers: Record<string,string> = { ...extraHeaders };
  if (who !== null) headers.authorization = `Bearer ${tokens[who] ?? who}`;
  const response = await fetch(`${base}/api/v1/crm/me?companyId=999`, {
    method: 'GET', headers, redirect: 'error'
  });
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json() as unknown
  };
}

describe('Local CRM HTTP authentication boundary (no MariaDB writes)', () => {
  beforeAll(async () => {
    const fixtures = [
      ['owner', '101', '10', 'OWNER', 'FULL', 'ACTIVE'],
      ['manager', '101', '20', 'MANAGER', 'FULL', 'ACTIVE'],
      ['employee', '101', '30', 'EMPLOYEE', 'FULL', 'ACTIVE'],
      ['readonly', '101', '21', 'MANAGER', 'READ_ONLY', 'ACTIVE'],
      ['other-company', '202', '40', 'EMPLOYEE', 'FULL', 'ACTIVE'],
      ['inactive', '101', '50', 'EMPLOYEE', 'FULL', 'INACTIVE'],
      ['denied', '101', '60', 'EMPLOYEE', 'DENIED', 'ACTIVE']
    ] as const;
    for (const [key, companyId, actorUserId, role, accessMode, membershipStatus] of fixtures) {
      const identityKey = `qa_local_${key}`;
      identities.registerIdentity(identityKey, {
        companyId, actorUserId, role, accessMode, membershipStatus
      });
      tokens[key] = sessions.issueSession(identityKey);
    }
    const app = createCrmApp({
      sessionVerifier: sessions.verifier,
      identityResolver: identities.resolver
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('QA_LISTEN_FAILED');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    } finally {
      sessions.clearSessions();
      identities.clearIdentities();
    }
  });

  it('exposes only the public health endpoint without authentication', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });
  it('rejects anonymous and fake bearer tokens', async () => {
    expect((await request(null)).status).toBe(401);
    expect((await request('forged_token')).status).toBe(401);
  });
  it.each([
    ['owner', 'OWNER', '10'],
    ['manager', 'MANAGER', '20'],
    ['employee', 'EMPLOYEE', '30'],
    ['readonly', 'MANAGER', '21']
  ])('returns trusted identity for %s', async (who, role, actor) => {
    const result = await request(who, { 'x-company-id': '999', 'x-role': 'OWNER' });
    expect(result.status).toBe(200);
    expect(result.cache).toContain('no-store');
    expect(result.body).toMatchObject({ data: {
      companyId: '101', actorUserId: actor, role
    } });
    expect(JSON.stringify(result.body)).not.toContain('qa_local_');
  });
  it('does not allow a client-provided company or role to override identity', async () => {
    const result = await request('other-company', { 'x-company-id': '101' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: {
      companyId: '202', role: 'EMPLOYEE', actorUserId: '40'
    } });
  });
  it('denies inactive and denied-access sessions', async () => {
    expect([401,403]).toContain((await request('inactive')).status);
    expect([401,403]).toContain((await request('denied')).status);
  });
});
