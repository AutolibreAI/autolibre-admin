import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type { QuoteRequestPhoto, QuoteRequestPhotos } from '~/lib/quote-photos'

/**
 * Fotos de un pedido (`public.quote_request_files` → `files`). Lectura por SQL;
 * el alta del archivo va por HTTP al backend (`~/fn/quote-photos`) y el ATADO
 * al pedido por `ops.add_quote_request_file` (020).
 *
 * Dos guards, como el resto de Pedidos: la tabla puede no existir en una base
 * vieja (`to_regclass`), y la 020 puede no estar aplicada
 * (`to_regprocedure`). Sin la tabla no hay nada que mostrar; sin la 020 se
 * muestran y no se cargan.
 */

interface Availability {
  table: boolean
  sp: boolean
}

export async function quotePhotosAvailability(): Promise<Availability> {
  const row = await sqlOne<{ has_table: boolean; has_sp: boolean }>(
    `select to_regclass('public.quote_request_files') is not null as has_table,
            to_regprocedure('ops.add_quote_request_file(uuid,uuid,uuid,text)') is not null as has_sp`,
  )
  return { table: row?.has_table === true, sp: row?.has_sp === true }
}

interface PhotoRow {
  id: string
  file_id: string
  purpose: string
  mime_type: string | null
  size_bytes: number | string | null
  created_at: Date | string
  is_requester: boolean | null
  uploader_role: string | null
  uploader_email: string | null
}

export async function listQuoteRequestPhotos(
  quoteRequestId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestPhotos> {
  void opts.signal

  const availability = await quotePhotosAvailability()
  if (!availability.table) return { available: false }

  // `JOIN files`: la FK es NOT NULL con `ON DELETE CASCADE`, así que una fila
  // sin archivo no es representable. `LEFT` a `users`: un archivo puede no
  // tener dueño (`files.user_id` es nullable).
  const rows = await sql<PhotoRow>(
    `select qrf.id, qrf.file_id, qrf.purpose::text as purpose,
            f.mime_type, f.size_bytes, qrf.created_at,
            (f.user_id = qr.user_id) as is_requester,
            u.role::text as uploader_role, u.email as uploader_email
       from quote_request_files qrf
       join quote_requests qr on qr.id = qrf.quote_request_id
       join files f on f.id = qrf.file_id
       left join users u on u.id = f.user_id
      where qrf.quote_request_id = $1
      order by qrf.created_at, qrf.id`,
    [quoteRequestId],
  )

  const photos: Array<QuoteRequestPhoto> = rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    purpose: r.purpose,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    createdAt: new Date(r.created_at).toISOString(),
    uploadedBy: r.is_requester ? 'requester' : r.uploader_role === 'admin' ? 'admin' : 'other',
    uploaderEmail: r.uploader_email,
  }))

  return { available: true, canUpload: availability.sp, photos }
}

/** Los `file_id` atados a ESTE pedido — lo único que el panel firma. */
export async function quoteRequestFileIds(quoteRequestId: string): Promise<Array<string>> {
  const rows = await sql<{ file_id: string }>(
    `select file_id from quote_request_files where quote_request_id = $1`,
    [quoteRequestId],
  )
  return rows.map((r) => r.file_id)
}

/** Ata un archivo ya registrado (`POST /files/confirm`) al pedido. Idempotente (020). */
export async function addQuoteRequestFile(
  input: { quoteRequestId: string; fileId: string },
  actorId: string,
): Promise<void> {
  await sqlOne(
    `select ops.add_quote_request_file(
       p_quote_request_id => $1, p_file_id => $2, p_actor_id => $3, p_purpose => $4) as row`,
    [input.quoteRequestId, input.fileId, actorId, 'problem_photo'],
  )
}

export interface DownloadableQuoteFile {
  fileId: string
  mimeType: string | null
  /** `AL-1068-problema-1791044606070-1.jpg`: el código del pedido + el nombre original. */
  fileName: string
}

/**
 * Los archivos de un pedido, listos para bajar. Con `fileId`, sólo ese — y
 * SÓLO si está atado a este pedido: el endpoint de descarga no baja un archivo
 * cualquiera por id.
 */
export async function quoteRequestDownloads(
  quoteRequestId: string,
  fileId?: string,
): Promise<{ publicNumber: number; files: Array<DownloadableQuoteFile> } | null> {
  const { table } = await quotePhotosAvailability()
  if (!table) return null

  const qr = await sqlOne<{ public_number: number | string }>(
    `select public_number from quote_requests where id = $1`,
    [quoteRequestId],
  )
  if (!qr) return null
  const publicNumber = Number(qr.public_number)

  const rows = await sql<{ file_id: string; mime_type: string | null; s3_key: string }>(
    `select qrf.file_id, f.mime_type, f.s3_key
       from quote_request_files qrf
       join files f on f.id = qrf.file_id
      where qrf.quote_request_id = $1 and ($2::uuid is null or qrf.file_id = $2)
      order by qrf.created_at, qrf.id`,
    [quoteRequestId, fileId ?? null],
  )

  const used = new Set<string>()
  const files = rows.map((r, i) => {
    // El nombre sale del final de la key (`files/<id>/<nombre original>`),
    // saneado para un header y un zip. Dos fotos con el mismo nombre no pueden
    // pisarse dentro del zip: la segunda lleva el número de orden.
    const base = (r.s3_key.split('/').pop() || `foto-${i + 1}`).replace(/[^A-Za-z0-9._-]+/g, '-')
    let fileName = `AL-${publicNumber}-${base}`
    if (used.has(fileName)) fileName = `AL-${publicNumber}-${i + 1}-${base}`
    used.add(fileName)
    return { fileId: r.file_id, mimeType: r.mime_type, fileName }
  })

  return { publicNumber, files }
}
