/*
 * The IAMF track of a (progressive) MP4 / M4A: the descriptor OBUs from its 'iacb' box and the byte range of every
 * sample (one IAMF temporal unit each, without a Temporal Delimiter). Pure functions on a Uint8Array.
 *
 * Fragmented MP4 (moof / trun) is not supported: it reports so instead of guessing.
 */

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4)
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

export interface Mp4IamfTrack {
  /** Descriptor OBUs (sequence header … mix presentations) for IAMF_decoder_configure. */
  config: Uint8Array
  samples: { offset: number; size: number }[]
}

interface Box {
  type: string
  /** Payload range (after the header). */
  start: number
  end: number
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start
  while (p + 8 <= end) {
    let size = u32(b, p)
    const type = fourcc(b, p + 4)
    let header = 8
    if (size === 1 && p + 16 <= end) {
      size = u64(b, p + 8)
      header = 16
    } else if (size === 0) size = end - p
    if (size < header) return
    yield { type, start: p + header, end: Math.min(end, p + size) }
    p += size
  }
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

/** Find a box type below `start..end` (depth first through the container boxes). */
function find(b: Uint8Array, start: number, end: number, want: string): Box | null {
  for (const box of boxes(b, start, end)) {
    if (box.type === want) return box
    if (CONTAINERS.has(box.type)) {
      const inner = find(b, box.start, box.end, want)
      if (inner) return inner
    }
  }
  return null
}

function leb(b: Uint8Array, at: number): { value: number; next: number } {
  let v = 0
  for (let i = 0; i < 8; i++) {
    const byte = b[at + i]
    v += (byte & 0x7f) * 2 ** (7 * i)
    if (!(byte & 0x80)) return { value: v, next: at + i + 1 }
  }
  throw new RangeError('bad leb128')
}

export function findIamfTrack(file: Uint8Array): Mp4IamfTrack {
  const moov = find(file, 0, file.length, 'moov')
  if (!moov) throw new Error('MP4 has no moov box (the whole file is needed)')
  for (const box of boxes(file, 0, file.length)) if (box.type === 'moof') throw new Error('fragmented MP4 is not supported yet')

  for (const trak of boxes(file, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue
    const stsd = find(file, trak.start, trak.end, 'stsd')
    if (!stsd || stsd.end - stsd.start < 16) continue
    const entry = stsd.start + 8
    if (fourcc(file, entry + 4) !== 'iamf') continue

    // IAConfigurationBox inside the sample entry (after the 28-byte AudioSampleEntry fields): version, leb128 size, OBUs.
    const entryEnd = Math.min(stsd.end, entry + u32(file, entry))
    let config: Uint8Array | null = null
    for (const child of boxes(file, entry + 36, entryEnd)) {
      if (child.type !== 'iacb') continue
      const { value, next } = leb(file, child.start + 1)
      config = file.subarray(next, Math.min(child.end, next + value))
    }
    if (!config) throw new Error('IAMF track has no iacb box')

    const stsz = find(file, trak.start, trak.end, 'stsz')
    const stsc = find(file, trak.start, trak.end, 'stsc')
    const stco = find(file, trak.start, trak.end, 'stco')
    const co64 = find(file, trak.start, trak.end, 'co64')
    if (!stsz || !stsc || !(stco || co64)) throw new Error('IAMF track has no sample table')

    const fixed = u32(file, stsz.start + 4)
    const count = u32(file, stsz.start + 8)
    const sizes = (i: number) => (fixed ? fixed : u32(file, stsz.start + 12 + i * 4))
    const chunkCount = u32(file, (stco ?? co64)!.start + 4)
    const chunkOffset = (i: number) => (stco ? u32(file, stco.start + 8 + i * 4) : u64(file, co64!.start + 8 + i * 8))
    const runs = u32(file, stsc.start + 4)
    const samples: { offset: number; size: number }[] = []
    let sample = 0
    for (let r = 0; r < runs && sample < count; r++) {
      const first = u32(file, stsc.start + 8 + r * 12)
      const per = u32(file, stsc.start + 8 + r * 12 + 4)
      const last = r + 1 < runs ? u32(file, stsc.start + 8 + (r + 1) * 12) - 1 : chunkCount
      for (let c = first; c <= last && sample < count; c++) {
        let offset = chunkOffset(c - 1)
        for (let k = 0; k < per && sample < count; k++, sample++) {
          const size = sizes(sample)
          samples.push({ offset, size })
          offset += size
        }
      }
    }
    return { config, samples }
  }
  throw new Error('MP4 has no IAMF track')
}
