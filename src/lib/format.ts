/**
 * Isomorphic formatters. Locale and time zone are pinned so server-rendered
 * markup byte-matches the client's first render — the usual cause of hydration
 * mismatches in a table full of dates and numbers.
 */
const int = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

const date = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Fecha + hora, para cuando el día no alcanza — una notificación programada y
 * enviada el mismo día sólo se distingue por la hora.
 *
 * `timeZone: 'UTC'` por el mismo motivo que `date`: el markup del servidor
 * tiene que coincidir byte a byte con el primer render del cliente, y una hora
 * en zona local produce dos strings distintos. La consecuencia es que la hora
 * que se ve es UTC, no ART — se asume y se documenta acá, no se "arregla" con
 * la zona del navegador.
 */
const dateTime = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export const formatInt = (n: number) => int.format(n);
export const formatDate = (iso: string) => date.format(new Date(iso));
/** Sin sufijo de zona — la hora es UTC y el llamador lo aclara una vez, no por celda. */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

/**
 * Tamaño de archivo en MB, con un decimal.
 *
 * Se corta en MB y no escala a GB porque el único archivo que este panel
 * muestra es un manual en PDF, y el backend los corta en 10MB
 * (`MAX_UPLOAD_FILE_SIZE_BYTES`). Un formateador que sepa hablar de terabytes
 * es código para un caso que no existe.
 *
 * Se usa 1024 y no 1000 a propósito: es la misma base con la que el backend
 * calcula su límite, así que un PDF que acá se lee "10.4 MB" es exactamente el
 * que allá rebota con 413. Con base 1000 los dos números discrepan justo en el
 * borde, que es el único lugar donde el número importa.
 *
 * Debajo de 1 MB se muestra en KB: `/documentos` lista fotos de cédula y
 * registro que pesan cientos de KB, y "0.2 MB" para todas se lee como ruido.
 */
export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
