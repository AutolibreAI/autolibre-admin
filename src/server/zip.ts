import '@tanstack/react-start/server-only'

/**
 * Un `.zip` mínimo, en modo STORE (sin comprimir), armado como stream.
 *
 * Existe para "Descargar todas" las fotos de un pedido. Sin dependencia: el
 * formato STORE es un header por archivo + el directorio central, y comprimir
 * no tiene sentido — un JPEG ya viene comprimido, deflate le saca casi nada.
 *
 * Va como `ReadableStream` y no como un buffer entero porque Vercel corta una
 * respuesta NO streameada en 4.5MB (`vehicle-manuals.md`, trampa 2), y tres
 * fotos de teléfono ya pasan eso. Cada archivo se trae entero de a uno (hace
 * falta su CRC antes del header), así que en memoria vive una foto por vez.
 *
 * Límites a propósito: sin ZIP64 (cada archivo y el total < 4GB, de sobra
 * para fotos) y nombres en UTF-8 (bit 11 de los flags).
 */

export interface ZipEntry {
  name: string
  /** Se llama recién cuando le toca a ese archivo. */
  load: () => Promise<Uint8Array>
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export function zipStream(entries: Array<ZipEntry>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(new Date())
  const central: Array<Uint8Array> = []
  let offset = 0
  let index = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < entries.length) {
        const entry = entries[index++]!
        const name = encoder.encode(entry.name)
        const data = await entry.load()
        const crc = crc32(data)

        const local = new DataView(new ArrayBuffer(30))
        local.setUint32(0, 0x04034b50, true)
        local.setUint16(4, 20, true)
        local.setUint16(6, 0x0800, true)
        local.setUint16(8, 0, true)
        local.setUint16(10, time, true)
        local.setUint16(12, date, true)
        local.setUint32(14, crc, true)
        local.setUint32(18, data.length, true)
        local.setUint32(22, data.length, true)
        local.setUint16(26, name.length, true)
        local.setUint16(28, 0, true)

        const cd = new DataView(new ArrayBuffer(46))
        cd.setUint32(0, 0x02014b50, true)
        cd.setUint16(4, 20, true)
        cd.setUint16(6, 20, true)
        cd.setUint16(8, 0x0800, true)
        cd.setUint16(10, 0, true)
        cd.setUint16(12, time, true)
        cd.setUint16(14, date, true)
        cd.setUint32(16, crc, true)
        cd.setUint32(20, data.length, true)
        cd.setUint32(24, data.length, true)
        cd.setUint16(28, name.length, true)
        cd.setUint32(42, offset, true)
        central.push(new Uint8Array(cd.buffer), name)

        controller.enqueue(new Uint8Array(local.buffer))
        controller.enqueue(name)
        controller.enqueue(data)
        offset += 30 + name.length + data.length
        return
      }

      const cdSize = central.reduce((n, part) => n + part.length, 0)
      for (const part of central) controller.enqueue(part)
      const end = new DataView(new ArrayBuffer(22))
      end.setUint32(0, 0x06054b50, true)
      end.setUint16(8, entries.length, true)
      end.setUint16(10, entries.length, true)
      end.setUint32(12, cdSize, true)
      end.setUint32(16, offset, true)
      controller.enqueue(new Uint8Array(end.buffer))
      controller.close()
    },
  })
}
