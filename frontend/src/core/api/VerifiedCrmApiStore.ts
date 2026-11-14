import { createContext, useContext } from 'react'
import type { ApiClient } from './apiClient'

/** API client reference only. The development token remains in the existing in-memory bridge. */
export const VerifiedCrmApiContext = createContext<ApiClient | null>(null)

export function useVerifiedCrmApi(): ApiClient | null {
    return useContext(VerifiedCrmApiContext)
}
