import '@tanstack/react-start/server-only'

import { getRequest } from '@tanstack/react-start/server'

/**
 * The inbound request's abort signal.
 *
 * Two different cancellations are in play and it is worth keeping them straight:
 *
 *  - The `signal` passed at a *call site* (`listVehicles({ data, signal })`)
 *    aborts the client's outbound fetch. Router hands loaders an
 *    `abortController` that fires when you navigate away mid-load.
 *
 *  - This one aborts the *server's* work when the client hangs up. Without it a
 *    cancelled navigation still burns a full query on the server.
 *
 * A server function handler has no `signal` on its context — it reads the
 * ambient request instead, which is what this wraps.
 */
export function requestSignal(): AbortSignal {
  return getRequest().signal
}
