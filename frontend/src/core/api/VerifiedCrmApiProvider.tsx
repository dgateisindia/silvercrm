import type { ReactNode } from 'react'
import type { ApiClient } from './apiClient'
import { VerifiedCrmApiContext } from './VerifiedCrmApiStore'

export function VerifiedCrmApiProvider({ client, children }: {
    client: ApiClient | null
    children: ReactNode
}) {
    return <VerifiedCrmApiContext.Provider value={client}>{children}</VerifiedCrmApiContext.Provider>
}
