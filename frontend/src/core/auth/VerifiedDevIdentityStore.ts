import { createContext, useContext } from 'react'

/** Verified development identity; never store a token here. */
export type VerifiedDevRole = 'OWNER' | 'MANAGER' | 'EMPLOYEE'
export type VerifiedDevIdentity = Readonly<{
    companyId: string
    actorUserId: string
    role: VerifiedDevRole
    accessMode: 'FULL'
}>
export const IdentityContext = createContext<VerifiedDevIdentity | null>(null)
export function useVerifiedDevIdentity(): VerifiedDevIdentity | null {
    return useContext(IdentityContext)
}