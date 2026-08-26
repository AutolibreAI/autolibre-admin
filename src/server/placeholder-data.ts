import '@tanstack/react-start/server-only'

import type { RecordItem } from '~/lib/types'

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER DOMAIN — SCHEDULED FOR DELETION
//
// This exists only so the routing, loader, streaming and SSR-mode scaffolding
// has something to render while the real screens are built. It is NOT AutoLibre
// data and must never be treated as such.
//
// It goes away with the first real screen — the PartnerApplication pipeline,
// whose full spec already exists as a DBeaver runbook at
// `autolibre-backend-hex/scripts/sql/aprobar-partner-application.sql`.
// See `.claude/rules/partner-approval.md`.
//
// Until then: nothing here is a pattern to copy. Real data goes through
// `~/server/db` (pg pool + stored procedures).
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_ROWS: ReadonlyArray<RecordItem> = [
  { id: 'rec_01', name: 'Registro 01', category: 'Categoría A', status: 'active', updatedAt: '2026-08-20T10:00:00.000Z' },
  { id: 'rec_02', name: 'Registro 02', category: 'Categoría A', status: 'pending', updatedAt: '2026-08-19T10:00:00.000Z' },
  { id: 'rec_03', name: 'Registro 03', category: 'Categoría B', status: 'active', updatedAt: '2026-08-18T10:00:00.000Z' },
  { id: 'rec_04', name: 'Registro 04', category: 'Categoría B', status: 'archived', updatedAt: '2026-08-17T10:00:00.000Z' },
  { id: 'rec_05', name: 'Registro 05', category: 'Categoría C', status: 'active', updatedAt: '2026-08-16T10:00:00.000Z' },
  { id: 'rec_06', name: 'Registro 06', category: 'Categoría C', status: 'pending', updatedAt: '2026-08-15T10:00:00.000Z' },
  { id: 'rec_07', name: 'Registro 07', category: 'Categoría A', status: 'active', updatedAt: '2026-08-14T10:00:00.000Z' },
  { id: 'rec_08', name: 'Registro 08', category: 'Categoría B', status: 'archived', updatedAt: '2026-08-13T10:00:00.000Z' },
  { id: 'rec_09', name: 'Registro 09', category: 'Categoría C', status: 'active', updatedAt: '2026-08-12T10:00:00.000Z' },
  { id: 'rec_10', name: 'Registro 10', category: 'Categoría A', status: 'pending', updatedAt: '2026-08-11T10:00:00.000Z' },
  { id: 'rec_11', name: 'Registro 11', category: 'Categoría B', status: 'active', updatedAt: '2026-08-10T10:00:00.000Z' },
  { id: 'rec_12', name: 'Registro 12', category: 'Categoría C', status: 'archived', updatedAt: '2026-08-09T10:00:00.000Z' },
]

export const source = {
  get records(): ReadonlyArray<RecordItem> {
    return PLACEHOLDER_ROWS
  },
}

/**
 * Artificial delay, so the streaming boundaries are observable in development.
 * Deletes along with the rest of this file — real latency will come from
 * Postgres.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    })
  })
}
