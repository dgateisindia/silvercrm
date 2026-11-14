import { ApiClientError, type ApiClient } from '../../core/api/apiClient'

export interface DashboardOverview {
    readonly scope: 'company' | 'managed_team' | 'own'
    readonly leadTotal: string
    readonly byStatus: readonly { readonly status: string; readonly count: string }[]
    readonly overdueTasks: string
    readonly dealsTotal: string
    readonly expectedDealValue: string
}
function record(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function count(v: unknown): string {
    if (typeof v !== 'string' || !/^\d+$/.test(v) || BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ApiClientError('response', 'Invalid dashboard count.')
    }
    return v
}
/** Expected deal value is NOT cash revenue; backend does not provide currency here. */
export async function readDashboardOverview(client: ApiClient, signal?: AbortSignal): Promise<DashboardOverview> {
    const raw = await client.request<unknown>({ path: 'dashboard/overview', method: 'GET', signal })
    if (!record(raw) || raw.success !== true || !record(raw.data)) {
        throw new ApiClientError('response', 'Unexpected dashboard response.')
    }
    const data = raw.data
    if (!['company', 'managed_team', 'own'].includes(String(data.scope)) ||
        !record(data.leads) || !record(data.tasks) || !record(data.deals) || !Array.isArray(data.leads.byStatus)) {
        throw new ApiClientError('response', 'Invalid dashboard data.')
    }
    const byStatus = data.leads.byStatus.map((item: unknown) => {
        if (!record(item) || typeof item.status !== 'string') {
            throw new ApiClientError('response', 'Invalid Lead status summary.')
        }
        return { status: item.status, count: count(item.count) }
    })
    if (byStatus.length > 100) throw new ApiClientError('response', 'Too many dashboard status values.')
    const amount = data.deals.expectedAmount
    if (typeof amount !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(amount)) {
        throw new ApiClientError('response', 'Invalid expected deal value.')
    }
    return {
        scope: data.scope as DashboardOverview['scope'],
        leadTotal: count(data.leads.total),
        byStatus,
        overdueTasks: count(data.tasks.overdue),
        dealsTotal: count(data.deals.total),
        expectedDealValue: amount,
    }
}
