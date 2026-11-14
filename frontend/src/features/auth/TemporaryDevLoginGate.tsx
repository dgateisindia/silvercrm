import { useMemo, useState, type FormEvent } from 'react'
import { KeyRound, LockKeyhole, LogOut, ShieldCheck } from 'lucide-react'

import CRMLayout from '../../layouts/CRMLayout'
import { createBrowserLocalDevApiBridge } from '../../core/auth/localDevApiBridge'
import { VerifiedDevIdentityProvider } from '../../core/auth/VerifiedDevIdentityContext'
import { VerifiedCrmApiProvider } from '../../core/api/VerifiedCrmApiProvider'
import type { VerifiedDevIdentity } from '../../core/auth/VerifiedDevIdentityStore'
import './TemporaryDevLogin.css'

type Role = 'OWNER' | 'MANAGER' | 'EMPLOYEE'

type MeEnvelope = {
    success: boolean
    data?: {
        companyId?: unknown
        actorUserId?: unknown
        role?: unknown
        accessMode?: unknown
    }
}

const ROLES: readonly { role: Role; label: string; description: string }[] = [
    { role: 'OWNER', label: 'Company Owner', description: 'Company reporting and oversight' },
    { role: 'MANAGER', label: 'Manager', description: 'Team operations and lead management' },
    { role: 'EMPLOYEE', label: 'Employee', description: 'Assigned leads and daily work' },
]

function isVerifiedIdentity(
    payload: MeEnvelope | null,
    selectedRole: Role,
): payload is MeEnvelope & { data: VerifiedDevIdentity } {
    const data = payload?.data
    return payload?.success === true &&
        data !== undefined &&
        data.role === selectedRole &&
        data.accessMode === 'FULL' &&
        typeof data.companyId === 'string' &&
        data.companyId.length > 0 &&
        typeof data.actorUserId === 'string' &&
        data.actorUserId.length > 0
}

/**
 * Temporary local-development sign-in only. A backend-issued token must
 * pass GET /api/v1/crm/me. The selection alone NEVER grants a role.
 * The SaaS/Clerk production sign-in will replace this gate.
 */
export default function TemporaryDevLoginGate() {
    const bridge = useMemo(() => {
        if (!import.meta.env.DEV) return null
        try {
            return createBrowserLocalDevApiBridge()
        } catch {
            return null
        }
    }, [])

    const [selectedRole, setSelectedRole] = useState<Role>('MANAGER')
    const [tokenInput, setTokenInput] = useState('')
    const [identity, setIdentity] = useState<VerifiedDevIdentity | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    async function signIn(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (busy || !bridge || !import.meta.env.DEV) return
        setError('')
        const value = tokenInput.trim()
        if (!value || /\s/.test(value)) {
            setError('Paste a valid development token from the local backend terminal.')
            return
        }
        setBusy(true)
        try {
            bridge.auth.setToken(value)
            const result = await bridge.client.request<MeEnvelope>({
                path: 'me',
                method: 'GET',
            })
            if (!isVerifiedIdentity(result, selectedRole)) {
                throw new Error('Role or access level does not match the verified backend session.')
            }
            setIdentity({
                companyId: result.data.companyId,
                actorUserId: result.data.actorUserId,
                role: result.data.role,
                accessMode: 'FULL',
            })
            setTokenInput('')
        } catch {
            bridge.auth.clearToken()
            setIdentity(null)
            setError('Sign-in rejected. Check the selected role, token and running local API.')
        } finally {
            setBusy(false)
        }
    }

    function signOut() {
        bridge?.auth.clearToken()
        setIdentity(null)
        setTokenInput('')
        setError('')
    }

    // Never expose an unprotected production shell while SaaS auth is unfinished.
    if (!import.meta.env.DEV) {
        return (
            <main className="temp-login-page">
                <section className="temp-login-card" role="status">
                    <div className="temp-login-brand">D-GATE / SILVER CRM</div>
                    <h1>Sign-in integration pending</h1>
                    <p>Production access will be provided through the D-GATE SaaS platform.</p>
                </section>
            </main>
        )
    }

    if (identity !== null) {
        const label = ROLES.find((item) => item.role === identity.role)?.label ?? identity.role
        return (
            <VerifiedDevIdentityProvider identity={identity}>
                <VerifiedCrmApiProvider client={bridge?.client ?? null}>
                <div className="temp-auth-workspace">
                    <CRMLayout user={{ name: `Dev ${label}`, role: `${label} · Local test` }} />
                    <aside className="temp-auth-session" aria-label="Temporary development session">
                        <span className="temp-auth-session-tag">LOCAL TEST</span>
                        <span className="temp-auth-session-role">{label} · User {identity.actorUserId}</span>
                        <button type="button" className="temp-auth-signout" onClick={signOut}>
                            <LogOut size={15} aria-hidden="true" /> Sign out
                        </button>
                    </aside>
                </div>
            </VerifiedCrmApiProvider>
            </VerifiedDevIdentityProvider>
        )
    }

    return (
        <main className="temp-login-page">
            <section className="temp-login-card" aria-labelledby="temp-login-heading">
                <div className="temp-login-brand"><span className="temp-login-mark">D</span> D-GATE / SILVER CRM</div>
                <div className="temp-login-badge"><ShieldCheck size={15} aria-hidden="true" /> LOCAL DEVELOPMENT ONLY</div>
                <h1 id="temp-login-heading">Sign in to test your CRM</h1>
                <p className="temp-login-intro">Choose a role and paste its temporary token from your local backend terminal. Your role is verified by the API, not by this screen.</p>

                <form onSubmit={(event) => { void signIn(event) }} autoComplete="off">
                    <fieldset className="temp-login-roles" disabled={busy}>
                        <legend>Select a test role</legend>
                        {ROLES.map((item) => (
                            <label key={item.role} className={`temp-login-role${selectedRole === item.role ? ' is-selected' : ''}`}>
                                <input type="radio" name="dev-role" value={item.role} checked={selectedRole === item.role} onChange={() => { setSelectedRole(item.role); setError('') }} />
                                <span className="temp-login-role-content"><strong>{item.label}</strong><small>{item.description}</small></span>
                            </label>
                        ))}
                    </fieldset>
                    <label className="temp-login-token-label" htmlFor="temp-dev-token"><KeyRound size={16} aria-hidden="true" /> Temporary access token</label>
                    <input
                        id="temp-dev-token"
                        className="temp-login-token-input"
                        type="password"
                        value={tokenInput}
                        onChange={(event) => setTokenInput(event.target.value)}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder="Paste the token for the selected role"
                        disabled={busy || !bridge}
                        required
                    />
                    {error && <p className="temp-login-error" role="alert">{error}</p>}
                    {!bridge && <p className="temp-login-error" role="alert">Local API configuration is missing. Run the setup script and restart Vite.</p>}
                    <button className="temp-login-submit" type="submit" disabled={busy || !bridge || !tokenInput.trim()}>
                        <LockKeyhole size={17} aria-hidden="true" /> {busy ? 'Verifying with backend…' : 'Verify token and enter CRM'}
                    </button>
                </form>
                <p className="temp-login-footer">Tokens exist only in memory and expire when the backend restarts. No passwords, cookies or local storage. This is not the SaaS production login.</p>
            </section>
            <aside className="temp-login-information">
                <div className="temp-login-information-mark">DG</div>
                <p className="temp-login-overline">BUILD · TEST · VERIFY</p>
                <h2>One workspace. Three verified roles.</h2>
                <p>Test the Owner, Manager and Employee experience independently while the SaaS sign-in is under development.</p>
                <div className="temp-login-information-note">Backend authorization remains mandatory for every CRM operation. Development identities alone do not unlock unprovisioned Leads data.</div>
            </aside>
        </main>
    )
}
