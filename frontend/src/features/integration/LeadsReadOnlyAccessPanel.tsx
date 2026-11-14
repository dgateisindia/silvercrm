import { useEffect, useRef, useState } from 'react'
import { ApiClientError } from '../../core/api/apiClient'
import { useVerifiedCrmApi } from '../../core/api/VerifiedCrmApiStore'
import { createLeadsReadApi } from '../leads/leadsApi'
import './LeadsReadOnlyAccessPanel.css'

type ReadState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'authorized'; firstPageCount: number }
    | { kind: 'unprovisioned' }
    | { kind: 'expired' }
    | { kind: 'unavailable' }
    | { kind: 'error' }

/** Explicit, GET-only browser probe of the real Leads authorization boundary. */
export default function LeadsReadOnlyAccessPanel() {
    const client = useVerifiedCrmApi()
    const [status, setStatus] = useState<ReadState>({ kind: 'idle' })
    const pending = useRef<AbortController | null>(null)

    useEffect(() => () => { pending.current?.abort() }, [])

    async function checkLeadsRead() {
        if (!client || status.kind === 'loading' || !import.meta.env.DEV) return
        pending.current?.abort()
        const controller = new AbortController()
        pending.current = controller
        setStatus({ kind: 'loading' })
        try {
            const result = await createLeadsReadApi(client).list({
                limit: 1,
                signal: controller.signal,
            })
            if (!controller.signal.aborted) {
                setStatus({ kind: 'authorized', firstPageCount: result.items.length })
            }
        } catch (error: unknown) {
            if (controller.signal.aborted) return
            if (error instanceof ApiClientError) {
                if (error.kind === 'authorization') {
                    setStatus({ kind: 'unprovisioned' })
                } else if (error.kind === 'authentication') {
                    setStatus({ kind: 'expired' })
                } else if (error.kind === 'network') {
                    setStatus({ kind: 'unavailable' })
                } else {
                    setStatus({ kind: 'error' })
                }
            } else {
                setStatus({ kind: 'error' })
            }
        } finally {
            if (pending.current === controller) pending.current = null
        }
    }

    if (!import.meta.env.DEV) return null

    let message = 'Not checked yet. Click to test real CRM Leads access (GET only).'
    if (status.kind === 'loading') message = 'Checking Leads access with the current verified session…'
    if (status.kind === 'unprovisioned') message = 'Access denied by backend (HTTP 403). CRM company/user provisioning is required; this is not an empty authorized lead list.'
    if (status.kind === 'expired') message = 'Session rejected by backend (HTTP 401). Sign out and use a fresh development token.'
    if (status.kind === 'unavailable') message = 'Cannot reach the local CRM API. Check that the backend is running on port 4001.'
    if (status.kind === 'error') message = 'The read-only check did not complete. No CRM records were changed.'
    if (status.kind === 'authorized') message = `Backend authorized the first page of Leads (${status.firstPageCount} record(s) returned with limit 1; not a company total).`

    return (
        <details className="crm-read-access-details">
            <summary>Connection diagnostics <span>Local development · optional</span></summary>
        <section className="crm-read-access" aria-label="Development CRM read authorization">
            <div className="crm-read-access-copy">
                <strong>Live CRM connection · Development only</strong>
                <p role="status" aria-live="polite">{message}</p>
            </div>
            <button
                type="button"
                className="crm-read-access-action"
                disabled={!client || status.kind === 'loading'}
                onClick={() => { void checkLeadsRead() }}
            >
                {status.kind === 'loading' ? 'Checking…' : 'Check Leads access'}
            </button>
        </section>
        </details>
    )
}
