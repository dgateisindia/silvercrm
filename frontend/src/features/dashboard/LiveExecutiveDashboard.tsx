import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
    AlertTriangle, ArrowRight, BriefcaseBusiness, CalendarDays, CheckCircle2,
    Clock3, LayoutDashboard, RefreshCw, Sparkles, Target, TrendingUp, Wallet,
} from 'lucide-react'
import { type ApiClient } from '../../core/api/apiClient'
import { createLeadsReadApi, type LeadApiRecord } from '../leads/leadsApi'
import { type DashboardOverview } from './dashboardLiveApi'
import './LiveExecutiveDashboard.css'

type Role = 'OWNER' | 'MANAGER' | 'EMPLOYEE'
type RecentState = { kind: 'loading' } | { kind: 'ready'; rows: readonly LeadApiRecord[] } | { kind: 'error' }

const colors = ['#6948db', '#b69cf5', '#c68a54', '#4376cb', '#21835d', '#d24e64']

function displayCount(value: string): string {
    return Number(value).toLocaleString('en-IN')
}

function statusCount(overview: DashboardOverview, key: string): string {
    const total = overview.byStatus.filter(item => item.status.toLowerCase() === key)
        .reduce((count, item) => count + BigInt(item.count), 0n)
    return total.toLocaleString('en-IN')
}

function expectedAmount(value: string): string {
    const amount = Number(value)
    return Number.isSafeInteger(amount) || (Number.isFinite(amount) && Math.abs(amount) < 1e12)
        ? amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })
        : value
}

function StatusPill({ status }: { status: string }) {
    const color = /^(won|qualified|contacted)$/i.test(status) ? 'green'
        : /^(lost|overdue)$/i.test(status) ? 'red'
        : /^(new|medium)$/i.test(status) ? 'orange' : 'violet'
    return <span className={`v2-status-pill v2-status-pill--${color}`}>{status}</span>
}

/** Local-only presentation of data returned by authorized CRM GET endpoints. No write or mock data. */
export default function LiveExecutiveDashboard({
    client, overview, title, description, role, onRefresh,
}: {
    client: ApiClient
    overview: DashboardOverview
    title: string
    description: string
    role: Role
    onRefresh: () => void
}) {
    const [recent, setRecent] = useState<RecentState>({ kind: 'loading' })
    useEffect(() => {
        const controller = new AbortController()
        void createLeadsReadApi(client).list({ limit: 5, signal: controller.signal })
            .then(result => { if (!controller.signal.aborted) setRecent({ kind: 'ready', rows: result.items }) })
            .catch(() => { if (!controller.signal.aborted) setRecent({ kind: 'error' }) })
        return () => controller.abort()
    }, [client, overview])

    const date = new Intl.DateTimeFormat('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    }).format(new Date())
    const greetingHour = new Date().getHours()
    const greeting = greetingHour < 12 ? 'Good morning' : greetingHour < 17 ? 'Good afternoon' : 'Good evening'
    const scope = role === 'OWNER' ? 'Company-wide' : role === 'MANAGER' ? 'Managed team' : 'My workspace'
    const totalLeads = Number(overview.leadTotal)
    const stages = overview.byStatus.map((stage, index) => ({
        ...stage,
        number: Number(stage.count),
        color: colors[index % colors.length],
    }))
    const nonzeroStages = stages.filter(stage => stage.number > 0)
    const totalStages = nonzeroStages.reduce((sum, stage) => sum + stage.number, 0)
    const stops = nonzeroStages.reduce<{ parts: string[]; offset: number }>((acc, stage) => {
        const end = acc.offset + (totalStages > 0 ? stage.number / totalStages * 100 : 0)
        return { offset: end, parts: [...acc.parts, `${stage.color} ${acc.offset.toFixed(2)}% ${end.toFixed(2)}%`] }
    }, { parts: [], offset: 0 }).parts
    const kpis = [
        { label: role === 'OWNER' ? 'Company Leads' : role === 'MANAGER' ? 'Team Leads' : 'My Leads', value: displayCount(overview.leadTotal), note: 'Backend-authorized records', icon: Target, tint: 'violet' },
        { label: 'Deals', value: displayCount(overview.dealsTotal), note: 'Deals in authorized scope', icon: BriefcaseBusiness, tint: 'blue' },
        { label: 'New Leads', value: statusCount(overview, 'new'), note: 'Currently in New status', icon: Sparkles, tint: 'violet' },
        { label: 'Overdue Tasks', value: displayCount(overview.overdueTasks), note: 'Past-due tasks', icon: AlertTriangle, tint: 'orange' },
        { label: 'Won Leads', value: statusCount(overview, 'won'), note: 'Currently in Won status', icon: CheckCircle2, tint: 'green' },
        { label: 'Expected Deal Value', value: expectedAmount(overview.expectedDealValue), note: 'Pipeline estimate, not earned revenue; currency unspecified', icon: Wallet, tint: 'orange' },
    ]

    return <div className="v2-executive-dashboard dashboard" aria-label={`${title} with backend data`}>
        <div className="v2-breadcrumb">Silver CRM <ArrowRight size={12} aria-hidden="true" /> Workspace <ArrowRight size={12} aria-hidden="true" /> <strong>Dashboard</strong></div>
        <div className="v2-page-head">
            <div><h1>{title}</h1><p>{description}</p></div>
            <div className="v2-page-actions">
                <span className="v2-scope-pill">{scope} · live</span>
                <button className="v2-btn v2-btn--soft" type="button" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" /> Refresh metrics</button>
            </div>
        </div>

        <section className="v2-hero" aria-label="Today's workspace pulse">
            <div className="v2-hero-copy"><div className="v2-kicker">✦ TODAY'S WORKSPACE PULSE</div>
                <h2>{greeting}. Welcome to your sales workspace.</h2>
                <p>{displayCount(overview.leadTotal)} Lead(s) in scope · {displayCount(overview.overdueTasks)} overdue task(s) · {displayCount(overview.dealsTotal)} deal(s). All figures come from the CRM backend.</p>
            </div>
            <div className="v2-hero-aside"><span><CalendarDays size={15} aria-hidden="true" /> {date}</span><Link to="/calendar">Open calendar <ArrowRight size={14} aria-hidden="true" /></Link></div>
        </section>

        <section className="v2-kpis" aria-label="Live role-specific dashboard key metrics">
            {kpis.map(item => <article className="v2-kpi" key={item.label}>
                <div className="v2-kpi-top"><span>{item.label}</span><span className={`v2-kpi-icon v2-kpi-icon--${item.tint}`}><item.icon size={18} aria-hidden="true" /></span></div>
                <strong className="v2-kpi-number">{item.value}</strong><p>{item.note}</p>
            </article>)}
        </section>

        <div className="v2-dashboard-grid">
            <section className="v2-content-card">
                <div className="v2-card-head"><div><h2>Lead status overview</h2><p>Actual status distribution across authorized Leads</p></div><span className="v2-label-pill">Live CRM data</span></div>
                <div className="v2-card-body">
                    {stages.length ? <div className="v2-status-chart">
                        {stages.map(stage => <div className="v2-progress-row" key={stage.status}>
                            <div><span>{stage.status}</span><strong>{displayCount(stage.count)}</strong></div>
                            <div className="v2-progress-track"><div style={{ width: `${totalLeads > 0 ? stage.number / totalLeads * 100 : 0}%`, background: stage.color }} /></div>
                        </div>)}
                    </div> : <div className="v2-empty"><LayoutDashboard size={25} aria-hidden="true" /><strong>No lead stages yet</strong><p>When Leads are saved, their actual statuses will appear here.</p></div>}
                </div>
                <Link className="v2-card-link" to="/leads">View all Leads <ArrowRight size={14} aria-hidden="true" /></Link>
            </section>
            <section className="v2-content-card">
                <div className="v2-card-head"><div><h2>Today's agenda</h2><p>Tasks, calls, and follow-ups</p></div><Clock3 size={18} aria-hidden="true" /></div>
                <div className="v2-card-body v2-agenda">
                    <div className="v2-agenda-placeholder"><CalendarDays size={24} aria-hidden="true" /><strong>Agenda details not connected</strong><p>The overview API currently provides overdue task counts, not individual appointments. No sample events are displayed.</p></div>
                    <div className="v2-attention"><span><span className="v2-attention-dot" /> <strong>{displayCount(overview.overdueTasks)} overdue task(s)</strong> need review</span><Link to="/tasks">View tasks <ArrowRight size={13} aria-hidden="true" /></Link></div>
                </div>
            </section>
        </div>

        <div className="v2-dashboard-grid v2-dashboard-grid--lower">
            <section className="v2-content-card">
                <div className="v2-card-head"><div><h2>Recent Leads</h2><p>Latest records from your authorized Leads list</p></div><Link to="/leads">All Leads <ArrowRight size={13} aria-hidden="true" /></Link></div>
                <div className="v2-table-scroll">
                    {recent.kind === 'loading' ? <div className="v2-empty" role="status">Loading recent Leads…</div> : recent.kind === 'error' ? <div className="v2-empty" role="alert">Unable to retrieve recent Leads. Dashboard totals remain from the authorized overview API.</div> : recent.rows.length === 0 ? <div className="v2-empty"><strong>No Leads returned</strong><p>No records were returned on this authorized page.</p></div> : <table className="v2-table"><thead><tr><th>Lead</th><th>Status</th><th>Priority</th><th>Owner ID</th></tr></thead><tbody>
                        {recent.rows.map(lead => <tr key={lead.id}><td><strong>{lead.title}</strong><small>#{lead.id}</small></td><td><StatusPill status={lead.status} /></td><td><StatusPill status={lead.priority} /></td><td>{lead.ownerUserId}</td></tr>)}
                    </tbody></table>}
                </div>
            </section>
            <section className="v2-content-card">
                <div className="v2-card-head"><div><h2>Where Leads stand</h2><p>Share of each configured Lead status</p></div><TrendingUp size={18} aria-hidden="true" /></div>
                <div className="v2-donut-body">
                    {nonzeroStages.length ? <><div className="v2-donut" style={{ background: `conic-gradient(${stops.join(', ')})` }}><div><strong>{displayCount(overview.leadTotal)}</strong><small>Total Leads</small></div></div><div className="v2-donut-key">{nonzeroStages.map(stage => <div key={stage.status}><span style={{ background: stage.color }} /><span>{stage.status}</span><strong>{totalStages ? Math.round(stage.number / totalStages * 100) : 0}%</strong></div>)}</div></> : <div className="v2-empty">No Lead distribution is available yet.</div>}
                </div>
            </section>
        </div>
        <div className="v2-quick-grid">
            <Link className="v2-quick-card" to="/leads"><Target size={22} aria-hidden="true" /><strong>Leads workspace</strong><p>Manage your authorized enquiries.</p><span>Open Leads <ArrowRight size={13} aria-hidden="true" /></span></Link>
            <Link className="v2-quick-card" to="/tasks"><Clock3 size={22} aria-hidden="true" /><strong>Next best action</strong><p>Review the tasks and follow-ups module.</p><span>Review tasks <ArrowRight size={13} aria-hidden="true" /></span></Link>
            <Link className="v2-quick-card" to="/opportunities"><BriefcaseBusiness size={22} aria-hidden="true" /><strong>Sales pipeline</strong><p>Explore opportunities; detailed stages require separate API integration.</p><span>Open pipeline <ArrowRight size={13} aria-hidden="true" /></span></Link>
        </div>
        <p className="v2-data-note">Live local development environment · {scope} permission scope verified by the backend · No illustrative sales figures or fabricated activities</p>
    </div>
}
