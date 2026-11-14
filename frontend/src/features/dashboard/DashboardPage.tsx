import { useEffect, useState } from 'react'
import { ApiClientError } from '../../core/api/apiClient'
import { useVerifiedCrmApi } from '../../core/api/VerifiedCrmApiStore'
import { readDashboardOverview, type DashboardOverview } from './dashboardLiveApi'
import LiveExecutiveDashboard from './LiveExecutiveDashboard'
import { Link } from 'react-router'
import { useVerifiedDevIdentity } from '../../core/auth/VerifiedDevIdentityStore'
import './VerifiedRoleDashboard.css'


import {
    Activity,
    ArrowRight,
    CalendarClock,
    ChartNoAxesColumn,
    Clock3,
    Target,
    TrendingUp,
    Wallet,
    type LucideIcon,
} from 'lucide-react'

export interface DashboardMetric {
    id: string
    label: string
    value: string | number | null
    description?: string
    icon?: string
}

export interface DashboardLeadStatus {
    id: string
    name: string
    count: number
    color?: string
}

export interface DashboardPipelineStage {
    id: string
    name: string
    opportunityCount: number
    valueLabel?: string
}

export interface DashboardActivity {
    id: string
    title: string
    description?: string
    timeLabel: string
}

export interface DashboardFollowUp {
    id: string
    title: string
    relatedTo?: string
    dueLabel: string
}

export interface DashboardData {
    metrics?: readonly DashboardMetric[]
    leadStatuses?: readonly DashboardLeadStatus[]
    pipelineStages?: readonly DashboardPipelineStage[]
    activities?: readonly DashboardActivity[]
    followUps?: readonly DashboardFollowUp[]
}

interface DashboardPageProps {
    data?: DashboardData | null
}

/** Presentation-only role distinctions; no records or permissions are inferred. */
const verifiedRoleViews = {
    OWNER: {
        title: 'Owner Dashboard',
        description: 'Company-wide reporting and manager oversight. Sales-record editing is not permitted.',
        summary: 'Company-wide reporting preview',
        leadMetric: 'Company Leads',
        opportunityMetric: 'Company Opportunities',
        followupMetric: 'Company Follow-ups',
        revenueMetric: 'Company Revenue',
    },
    MANAGER: {
        title: 'Manager Dashboard',
        description: 'Team operations, assignments, performance and sales follow-ups.',
        summary: 'Team management preview',
        leadMetric: 'Team Leads',
        opportunityMetric: 'Team Opportunities',
        followupMetric: 'Team Follow-ups',
        revenueMetric: 'Team Revenue',
    },
    EMPLOYEE: {
        title: 'Employee Dashboard',
        description: 'Your assigned leads, activities, follow-ups and individual performance.',
        summary: 'Individual sales preview',
        leadMetric: 'My Leads',
        opportunityMetric: 'My Opportunities',
        followupMetric: 'My Follow-ups',
        revenueMetric: 'My Revenue',
    },
} as const

const metricIcons: Record<string, LucideIcon> = {
    leads: Target,
    opportunities: TrendingUp,
    followups: CalendarClock,
    revenue: Wallet,
}

const initialMetrics: readonly DashboardMetric[] = [
    {
        id: 'leads',
        label: 'Total Leads',
        value: null,
        description: 'Lead records',
    },
    {
        id: 'opportunities',
        label: 'Open Opportunities',
        value: null,
        description: 'Active sales opportunities',
    },
    {
        id: 'followups',
        label: 'Pending Follow-ups',
        value: null,
        description: 'Actions requiring attention',
    },
    {
        id: 'revenue',
        label: 'Total Revenue',
        value: null,
        description: 'Revenue reporting',
    },
]

function EmptyState({ message }: { message: string }) {
    return (
        <div className="dashboard-empty">
            <ChartNoAxesColumn
                size={25}
                strokeWidth={1.5}
                aria-hidden="true"
            />
            <p>{message}</p>
        </div>
    )
}

export default function DashboardPage({
    data,
}: DashboardPageProps) {
    const verifiedIdentity = useVerifiedDevIdentity()
    const client = useVerifiedCrmApi()
    const [reload, setReload] = useState(0)
    const [live, setLive] = useState<
        { kind: 'idle' | 'loading' } |
        { kind: 'ready'; overview: DashboardOverview } |
        { kind: 'error'; message: string }
    >({ kind: 'idle' })
    const role = verifiedIdentity?.role
    useEffect(() => {
        if (!import.meta.env.DEV || !client || data !== undefined || !role) return
        const controller = new AbortController()
        void readDashboardOverview(client, controller.signal).then(overview => {
            if (controller.signal.aborted) return
            const expected = role === 'OWNER' ? 'company' : role === 'MANAGER' ? 'managed_team' : 'own'
            if (overview.scope !== expected) {
                setLive({ kind: 'error', message: 'Dashboard scope did not match your verified role.' })
                return
            }
            setLive({ kind: 'ready', overview })
        }).catch((error: unknown) => {
            if (controller.signal.aborted) return
            const message = error instanceof ApiClientError && error.kind === 'authentication' ?
                'Your session expired. Sign out and use a new local token.' :
                error instanceof ApiClientError && error.kind === 'authorization' ?
                    'The backend denied dashboard access.' : 'Dashboard API unavailable or returned invalid data.'
            setLive({ kind: 'error', message })
        })
        return () => controller.abort()
    }, [client, data, role, reload])
    const roleView = verifiedIdentity ? verifiedRoleViews[verifiedIdentity.role] : null
    const roleMetricLabels = roleView ? {
        leads: roleView.leadMetric,
        opportunities: roleView.opportunityMetric,
        followups: roleView.followupMetric,
        revenue: roleView.revenueMetric,
    } : null
    const liveOverview = live.kind === 'ready' && import.meta.env.DEV && client ? live.overview : null
    const liveMetrics: readonly DashboardMetric[] | undefined = liveOverview ? [
        { id: 'leads', label: roleView?.leadMetric ?? 'Leads', value: liveOverview.leadTotal, description: 'Backend-authorized Lead count' },
        { id: 'opportunities', label: 'Deals', value: liveOverview.dealsTotal, description: 'Backend-authorized Deal count (not opportunities)' },
        { id: 'followups', label: 'Overdue Tasks', value: liveOverview.overdueTasks, description: 'Past-due task count (not all follow-ups)' },
        { id: 'revenue', label: 'Expected Deal Value', value: liveOverview.expectedDealValue, description: 'Pipeline estimate, not earned revenue; currency unspecified' },
    ] : undefined
    const metrics = data?.metrics ?? liveMetrics ?? (roleMetricLabels
        ? initialMetrics.map((metric) => ({
            ...metric,
            label: roleMetricLabels[metric.id as keyof typeof roleMetricLabels] ?? metric.label,
        }))
        : initialMetrics)
    const leadStatuses = data?.leadStatuses ?? (liveOverview ? liveOverview.byStatus.map(item => ({
        id: item.status, name: item.status, count: Number(item.count), color: undefined,
    })) : [])
    const pipelineStages = data?.pipelineStages ?? []
    const activities = data?.activities ?? []
    const followUps = data?.followUps ?? []

    const totalLeads = leadStatuses.reduce(
        (sum, status) => sum + Math.max(0, status.count),
        0
    )

    if (liveOverview && roleView && verifiedIdentity && client && data === undefined) {
        return (
            <LiveExecutiveDashboard client={client} overview={liveOverview}
                title={roleView.title} description={roleView.description}
                role={verifiedIdentity.role}
                onRefresh={() => { setLive({ kind: 'loading' }); setReload(value => value + 1) }} />
        )
    }

    return (
        <div className="dashboard">
            {roleView && (
                <section className="dashboard-role-context" aria-label="Verified CRM role dashboard">
                    <div>
                        <h2>{roleView.title} · {liveOverview ? 'Live local data' : 'Development workspace'}</h2>
                        <p>{roleView.description} {liveOverview ? 'Metrics loaded from your backend-authorized scope.' : 'No live metrics are shown until backend-authorized CRM data is connected.'}</p>
                    </div>
                    <span>Backend-verified role</span>
                </section>
            )}
            {import.meta.env.DEV && client && data === undefined && (
                <div className="dashboard-role-context" role="status" aria-live="polite">
                    <span>{liveOverview ? `Live dashboard · ${liveOverview.scope}` :
                        live.kind === 'error' ? live.message : 'Loading role-scoped dashboard metrics…'}</span>
                    <button type="button" onClick={() => { setLive({ kind: 'loading' }); setReload(value => value + 1) }}>
                        Refresh metrics
                    </button>
                </div>
            )}
            <header className="dashboard-heading">
                <div>
                    <div className="dashboard-eyebrow">
                        D-GATE / SILVER CRM
                    </div>

                    <h1>{roleView?.title ?? 'Dashboard'}</h1>

                    <p>
                        {roleView?.description ?? 'Your sales workspace, activities, and business overview.'}
                    </p>
                </div>

                <span className="dashboard-mode">
                    {roleView?.summary ?? 'Workspace overview'}
                </span>
            </header>

            <section
                className="dashboard-metrics"
                aria-label="Dashboard key metrics"
            >
                {metrics.length === 0 ? (
                    <EmptyState message="No dashboard metrics configured." />
                ) : (
                    metrics.map((metric) => {
                        const MetricIcon =
                            metricIcons[metric.icon ?? metric.id] ??
                            Activity

                        return (
                            <article
                                className="dashboard-metric-card"
                                key={metric.id}
                            >
                                <div className="dashboard-metric-top">
                                    <span>{metric.label}</span>

                                    <div className="dashboard-metric-icon">
                                        <MetricIcon
                                            size={19}
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        />
                                    </div>
                                </div>

                                <strong className="dashboard-metric-value">
                                    {metric.value ?? '—'}
                                </strong>

                                <p className="dashboard-metric-description">
                                    {metric.description ?? ' '}
                                </p>
                            </article>
                        )
                    })
                )}
            </section>

            <div className="dashboard-grid">
                <section className="dashboard-panel">
                    <div className="dashboard-panel-heading">
                        <div>
                            <h2>Leads by Status</h2>
                            <p>Current lead distribution</p>
                        </div>

                        <Target
                            size={19}
                            aria-hidden="true"
                        />
                    </div>

                    {leadStatuses.length === 0 ? (
                        <EmptyState message={liveOverview ? 'No Leads recorded in this authorized scope yet.' : 'Lead status data is not connected yet.'} />
                    ) : (
                        <div className="dashboard-status-list">
                            {leadStatuses.map((status) => {
                                const percentage =
                                    totalLeads > 0
                                        ? (Math.max(0, status.count) /
                                              totalLeads) *
                                          100
                                        : 0

                                return (
                                    <div
                                        className="dashboard-status-item"
                                        key={status.id}
                                    >
                                        <div className="dashboard-status-label">
                                            <span>{status.name}</span>
                                            <strong>{status.count}</strong>
                                        </div>

                                        <div className="dashboard-progress">
                                            <div
                                                className="dashboard-progress-fill"
                                                style={{
                                                    width: `${percentage}%`,
                                                    backgroundColor:
                                                        status.color ??
                                                        'var(--color-violet)',
                                                }}
                                            />
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    <Link
                        className="dashboard-panel-link"
                        to="/leads"
                    >
                        View Leads
                        <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                </section>

                <section className="dashboard-panel">
                    <div className="dashboard-panel-heading">
                        <div>
                            <h2>Sales Pipeline</h2>
                            <p>Opportunity stages</p>
                        </div>

                        <TrendingUp
                            size={19}
                            aria-hidden="true"
                        />
                    </div>

                    {pipelineStages.length === 0 ? (
                        <EmptyState message={liveOverview ? 'Deal totals are live; detailed pipeline stages need separate integration.' : 'Pipeline data is not connected yet.'} />
                    ) : (
                        <div className="dashboard-pipeline">
                            {pipelineStages.map((stage) => (
                                <div
                                    className="dashboard-pipeline-row"
                                    key={stage.id}
                                >
                                    <div>
                                        <strong>{stage.name}</strong>
                                        <span>
                                            {stage.opportunityCount}
                                            {' '}opportunities
                                        </span>
                                    </div>

                                    <b>{stage.valueLabel ?? '—'}</b>
                                </div>
                            ))}
                        </div>
                    )}

                    <Link
                        className="dashboard-panel-link"
                        to="/opportunities"
                    >
                        View Opportunities
                        <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                </section>

                <section className="dashboard-panel">
                    <div className="dashboard-panel-heading">
                        <div>
                            <h2>Recent Activities</h2>
                            <p>Latest CRM activity</p>
                        </div>

                        <Activity
                            size={19}
                            aria-hidden="true"
                        />
                    </div>

                    {activities.length === 0 ? (
                        <EmptyState message="No recent activities available." />
                    ) : (
                        <div className="dashboard-activity-list">
                            {activities.map((activity) => (
                                <div
                                    className="dashboard-activity"
                                    key={activity.id}
                                >
                                    <span className="dashboard-activity-marker" />

                                    <div>
                                        <strong>{activity.title}</strong>
                                        {activity.description && (
                                            <p>{activity.description}</p>
                                        )}
                                        <small>{activity.timeLabel}</small>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                <section className="dashboard-panel">
                    <div className="dashboard-panel-heading">
                        <div>
                            <h2>Upcoming Follow-ups</h2>
                            <p>Scheduled actions</p>
                        </div>

                        <Clock3
                            size={19}
                            aria-hidden="true"
                        />
                    </div>

                    {followUps.length === 0 ? (
                        <EmptyState message="No upcoming follow-ups available." />
                    ) : (
                        <div className="dashboard-followup-list">
                            {followUps.map((followUp) => (
                                <div
                                    className="dashboard-followup"
                                    key={followUp.id}
                                >
                                    <CalendarClock
                                        size={17}
                                        aria-hidden="true"
                                    />

                                    <div>
                                        <strong>{followUp.title}</strong>
                                        {followUp.relatedTo && (
                                            <p>{followUp.relatedTo}</p>
                                        )}
                                        <small>{followUp.dueLabel}</small>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <Link
                        className="dashboard-panel-link"
                        to="/tasks"
                    >
                        View Tasks
                        <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                </section>
            </div>
        </div>
    )
}