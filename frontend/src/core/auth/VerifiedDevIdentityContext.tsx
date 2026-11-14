import type { ReactNode } from 'react'
import { IdentityContext, type VerifiedDevIdentity } from './VerifiedDevIdentityStore'

export function VerifiedDevIdentityProvider({ identity, children }: {
    identity: VerifiedDevIdentity
    children: ReactNode
}) {
    return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}