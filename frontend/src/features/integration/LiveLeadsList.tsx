import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, Search, Users } from 'lucide-react'
import { ApiClientError, type ApiClient } from '../../core/api/apiClient'
import { createLeadsReadApi, type LeadsListResult } from '../leads/leadsApi'
import './LiveLeadsList.css'

const PAGE_SIZE = 25

type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; page: LeadsListResult }
    | { kind: 'unauthorized' }
    | { kind: 'expired' }
    | { kind: 'unavailable' }
    | { kind: 'error' }

function classifyError(error: unknown): LoadState {
    if (error instanceof ApiClientError) {
        if (error.kind === 'authorization') return { kind: 'unauthorized' }
        if (error.kind === 'authentication') return { kind: 'expired' }
        if (error.kind === 'network') return { kind: 'unavailable' }
    }
    return { kind: 'error' }
}

/**
 * Development-only, GET-only Leads table.
 * All returned rows are already scoped by the backend.
 * A server cursor is not a count; search/status filters apply to the loaded page only.
 */
export default function LiveLeadsList({ client }: { client: ApiClient }) {
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
    const [retry, setRetry] = useState(0)
    const [status, setStatus] = useState<LoadState>({ kind: 'loading' })
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState('')
    const cursor = cursors[cursors.length - 1]

    useEffect(() => {
        const controller = new AbortController()
        void createLeadsReadApi(client).list({
            limit: PAGE_SIZE,
            beforeId: cursor,
            signal: controller.signal,
        }).then(page => {
            if (!controller.signal.aborted) setStatus({ kind: 'ready', page })
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) setStatus(classifyError(error))
        })
        return () => controller.abort()
    }, [client, cursor, retry])

    const page = status.kind === 'ready' ? status.page : null
    const statuses = useMemo(() => (
        [...new Set(page?.items.map(item => item.status) ?? [])].sort()
    ), [page])
    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase()
        return (page?.items ?? []).filter(lead => {
            const matchesStatus = !statusFilter || lead.status === statusFilter
            const haystack = [lead.id, lead.title, lead.accountId ?? '', lead.status, lead.priority, lead.ownerUserId]
                .join(' ').toLowerCase()
            return matchesStatus && (!term || haystack.includes(term))
        })
    }, [page, search, statusFilter])

    const canNext = !!page?.pagination.nextCursor && page.pagination.nextCursor !== cursor
    const pageNo = cursors.length

    function goNext() {
        const nextCursor = page?.pagination.nextCursor
        if (!nextCursor || nextCursor === cursor) return
        setSearch('')
        setStatusFilter('')
        setStatus({ kind: 'loading' })
        setCursors(previous => [...previous, nextCursor])
    }

    function goPrevious() {
        if (cursors.length < 2) return
        setSearch('')
        setStatusFilter('')
        setStatus({ kind: 'loading' })
        setCursors(previous => previous.slice(0, -1))
    }

    function reload() {
        setStatus({ kind: 'loading' })
        setRetry(previous => previous + 1)
    }

    return (
        <section className="leads-panel live-leads" aria-label="Authorized live Leads">
            <div className="leads-panel-heading">
                <div>
                    <h2>Authorized Leads</h2>
                    <p role="status" aria-live="polite">
                        {status.kind === 'loading' ? 'Loading authorized Leads…' :
                            page ? `Page ${pageNo}: ${page.items.length} record(s) returned; not a company-wide total` :
                                'Live Leads data is not available'}
                    </p>
                </div>
                <button type="button" className="live-leads-refresh" onClick={reload} disabled={status.kind === 'loading'}>
                    <RefreshCw size={16} aria-hidden="true" /> Refresh
                </button>
            </div>

            {page && (
                <>
                    <div className="leads-toolbar">
                        <label className="leads-search">
                            <Search size={17} aria-hidden="true" />
                            <input aria-label="Search loaded Leads page" type="search" placeholder="Search this page…"
                                value={search} onChange={event => setSearch(event.target.value)} />
                        </label>
                        <label className="leads-status-filter">
                            <select aria-label="Filter loaded Leads page by status" value={statusFilter}
                                onChange={event => setStatusFilter(event.target.value)}>
                                <option value="">All statuses on this page</option>
                                {statuses.map(value => <option key={value} value={value}>{value}</option>)}
                            </select>
                        </label>
                    </div>
                    <p className="live-leads-note">Search and status filters affect this page only. Account and owner are shown by ID until lookup APIs are connected.</p>
                    <div className="leads-table-wrap">
                        <table className="leads-table">
                            <thead><tr>
                                <th scope="col">Lead title</th>
                                <th scope="col">Account ID</th>
                                <th scope="col">Status</th>
                                <th scope="col">Priority</th>
                                <th scope="col">Owner user ID</th>
                            </tr></thead>
                            <tbody>{filtered.map(lead => (
                                <tr key={lead.id}>
                                    <td><span className="v2-live-lead-title">{lead.title}</span><small className="v2-live-lead-id">Lead #{lead.id}</small></td>
                                    <td>{lead.accountId ?? '—'}</td>
                                    <td><span className="v2-live-badge">{lead.status}</span></td>
                                    <td><span className="v2-live-badge v2-live-badge--priority">{lead.priority}</span></td>
                                    <td>{lead.ownerUserId}</td>
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                    {filtered.length === 0 && (
                        <div className="leads-empty" role="status">
                            <Users size={26} aria-hidden="true" />
                            <h3>{page.items.length === 0 ? 'No Leads returned on this authorized page' : 'No matching Leads on this page'}</h3>
                            <p>{page.items.length === 0 ? 'The backend returned an empty page. This is not a count of all company Leads.' : 'Try changing this page’s search or status filter.'}</p>
                        </div>
                    )}
                    <div className="live-leads-pager">
                        <button type="button" onClick={goPrevious} disabled={cursors.length <= 1}>
                            <ChevronLeft size={15} aria-hidden="true" /> Previous
                        </button>
                        <span>Page {pageNo}</span>
                        <button type="button" onClick={goNext} disabled={!canNext}>
                            Next <ChevronRight size={15} aria-hidden="true" />
                        </button>
                    </div>
                </>
            )}
            {status.kind !== 'ready' && status.kind !== 'loading' && (
                <div className="leads-empty" role="alert">
                    <h3>{status.kind === 'unauthorized' ? 'CRM Leads access denied (HTTP 403)' :
                        status.kind === 'expired' ? 'Session expired (HTTP 401)' :
                            status.kind === 'unavailable' ? 'Local CRM API unavailable' : 'Unable to load authorized Leads'}</h3>
                    <p>{status.kind === 'unauthorized' ? 'The backend has denied this request. No rows are treated as authorized.' :
                        status.kind === 'expired' ? 'Sign out and sign in with a current development token.' :
                            status.kind === 'unavailable' ? 'Check that your local backend is running on port 4001.' :
                                'Please retry. No CRM data has been modified.'}</p>
                    <button type="button" onClick={reload}>Retry GET request</button>
                </div>
            )}
            {status.kind === 'loading' && <div className="leads-empty" role="status">Loading authorized Leads…</div>}
        </section>
    )
}
