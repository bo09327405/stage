import { createContext, useContext } from 'react'
import type { useIntercom } from '../../hooks/useIntercom'

export type Intercom = ReturnType<typeof useIntercom>

/** The page's intercom station (one per tab), for Intercom blocks on the control surface. */
export const IntercomContext = createContext<Intercom | null>(null)

export const useIntercomContext = () => useContext(IntercomContext)
