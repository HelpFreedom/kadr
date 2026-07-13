// Sequential MP4 frame source for export: demux with mp4box, decode with
// WebCodecs. Every frame is decoded exactly once in stream order — no
// HTMLVideoElement seek round-trips, which dominate export time otherwise.
// Anything unexpected (non-MP4, unsupported codec, decode error) makes the
// caller fall back to the classic element-seek path, so exports keep working
// on machines and files this path can't handle.
import * as MP4Box from 'mp4box'
import type { MediaAsset } from '@shared/types'

/** non-faststart files keep moov at the end — give up early and fall back */
const HEAD_LIMIT = 16 * 1024 * 1024

type MP4File = ReturnType<typeof MP4Box.createFile>

interface Sample {
  is_sync: boolean
  cts: number
  duration: number
  timescale: number
  data: Uint8Array
  number: number
}

export class Mp4FrameSource {
  private file = MP4Box.createFile()
  private url: string
  private trackId = 0
  private config: VideoDecoderConfig | null = null
  private decoder: VideoDecoder | null = null
  private pendingChunks: EncodedVideoChunk[] = []
  private outFrames: VideoFrame[] = []
  private current: VideoFrame | null = null
  /** the frame right after `current` — read-ahead for frame blending */
  private ahead: VideoFrame | null = null
  private started = false
  private demuxDone = false
  private flushing = false
  private flushedAll = false
  private fatal = false
  private fetchAbort: AbortController | null = null
  private fileOffset = 0
  private ready = false
  private moovFound = false
  /** moof/mdat stream (moov has no sample table) — jumps re-pump from 0 */
  private fragmented = false
  /** active fragmented jump: drop demuxed chunks before the target GOP */
  private skipTargetUs: number | null = null
  /** chunks of the newest keyframe-led GOP at or before the skip target */
  private gopBuffer: EncodedVideoChunk[] = []
  private waiters: (() => void)[] = []
  private ctsShift = 0
  private sampleScale = 0
  private scratch: Uint8Array | null = null

  static async open(asset: MediaAsset): Promise<Mp4FrameSource | null> {
    try {
      const src = new Mp4FrameSource(asset)
      if (await src.init()) return src
      src.close()
      return null
    } catch {
      return null
    }
  }

  private constructor(asset: MediaAsset) {
    this.url = window.kadr.fileUrl(asset.path)
  }

  private kick() {
    const ws = this.waiters.splice(0)
    for (const w of ws) w()
  }

  private wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r))
  }

  /**
   * Sample intake shared by the init demux and fragmented-jump restarts.
   * While a fragmented jump is skipping, chunks are not queued for decode:
   * only the newest keyframe-led GOP at or before the target is kept, and
   * the first keyframe past the target releases it into pendingChunks.
   */
  private ingestSamples(file: MP4File, samples: Sample[]) {
    if (this.fatal) return
    for (const s of samples) {
      this.sampleScale = s.timescale
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(((s.cts - this.ctsShift) * 1e6) / s.timescale),
        duration: Math.round((s.duration * 1e6) / s.timescale),
        data: s.data
      })
      if (this.skipTargetUs !== null) {
        if (s.is_sync) {
          if (chunk.timestamp <= this.skipTargetUs) {
            this.gopBuffer = [chunk] // closer candidate — drop the older GOP
          } else {
            // first keyframe past the target: the candidate GOP is final
            this.pendingChunks.push(...this.gopBuffer, chunk)
            this.gopBuffer = []
            this.skipTargetUs = null
          }
        } else if (this.gopBuffer.length) {
          this.gopBuffer.push(chunk)
          if (this.gopBuffer.length > 4000) {
            this.fatal = true // runaway GOP — bail out to the element path
            break
          }
        } // deltas before the first keyframe are undecodable — drop
      } else {
        this.pendingChunks.push(chunk)
      }
    }
    try {
      file.releaseUsedSamples(this.trackId, samples[samples.length - 1].number)
    } catch { /* memory bound is best-effort */ }
    this.feed()
    this.kick()
  }

  /** stream over — whatever GOP the skip was holding is the tail GOP */
  private finishSkip() {
    if (this.skipTargetUs === null) return
    this.pendingChunks.push(...this.gopBuffer)
    this.gopBuffer = []
    this.skipTargetUs = null
  }

  private async init(): Promise<boolean> {
    // collect samples from the very start: chunks queue up even before the
    // decoder exists, feed() drains them once it's configured
    const initFile = this.file
    initFile.onSamples = (_id: number, _u: unknown, samples: Sample[]) =>
      this.ingestSamples(initFile, samples)
    const info = await new Promise<any>((resolve, reject) => {
      // everything must be wired SYNCHRONOUSLY inside onReady: with a
      // faststart file (moov first) the pump keeps appending mdat right
      // after this callback, and samples that stream through mp4box before
      // setExtractionOptions()/start() are consumed silently — that froze
      // exports to the first frame on faststart sources
      this.file.onReady = (i: any) => {
        this.moovFound = true
        try {
          const track = i.videoTracks?.[0]
          if (track) {
            this.trackId = track.id
            // edit lists shift presentation (B-frame delay etc.); <video>
            // honors them, raw samples don't — apply to our timestamps
            try {
              const trak = this.file.getTrackById(track.id)
              const entries = trak?.edts?.elst?.entries ?? []
              const e = entries.find((x: { media_time: number }) => x.media_time >= 0)
              if (e) this.ctsShift = e.media_time
            } catch { /* no edit list */ }
            this.file.setExtractionOptions(track.id, null, { nbSamples: 30 })
            this.file.start()
          }
        } catch { /* validated below */ }
        resolve(i)
      }
      this.file.onError = (e: unknown) => reject(new Error(String(e)))
      this.headReject = reject
      void this.pump(0)
    }).catch(() => null)
    if (!info) return false

    const track = info.videoTracks?.[0]
    if (!track) return false
    this.fragmented = !!info.isFragmented
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.video?.width || track.track_width,
      codedHeight: track.video?.height || track.track_height,
      description: this.description()
    }
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) return false
    this.config = config
    if (this.fragmented) {
      // fragmented streams put moov first, so extraction was armed inside
      // onReady before any moof was parsed: chunks already queue from sample
      // 0 — just attach the decoder and drain. (mp4box seek() is useless
      // here: moov has no sample table, and jump(0) used to feed the fresh
      // decoder a mid-GOP delta chunk → DataError → element fallback.)
      this.makeDecoder()
      this.feed()
    } else {
      // restart the stream from the first sample: with moov at the END the
      // head pump has already swept past all of mdat before the sample table
      // was known, and mp4box can't extract from data it has discarded —
      // re-pumping from the seek offset feeds it everything again, now armed
      this.jump(0)
    }
    this.ready = true
    return true
  }

  /** avcC/hvcC/vpcC/av1C box payload (without the 8-byte box header) */
  private description(): Uint8Array | undefined {
    try {
      const trak = this.file.getTrackById(this.trackId)
      for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
        if (box) {
          const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
          box.write(stream)
          return new Uint8Array(stream.buffer, 8)
        }
      }
    } catch { /* some codecs carry no description */ }
    return undefined
  }

  private makeDecoder() {
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.outFrames.push(f)
        this.kick()
      },
      error: () => {
        this.fatal = true
        this.kick()
      }
    })
    if (this.config) this.decoder.configure(this.config)
  }

  private headReject: ((e: Error) => void) | null = null

  private async pump(offset: number) {
    this.fetchAbort?.abort()
    const ac = new AbortController()
    this.fetchAbort = ac
    this.fileOffset = offset
    try {
      const res = await fetch(this.url, {
        signal: ac.signal,
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined
      })
      const reader = res.body!.getReader()
      for (;;) {
        if (ac.signal.aborted) return
        // backpressure: stay a bounded distance ahead of the decoder
        if (this.pendingChunks.length > 240) {
          await this.wait()
          continue
        }
        const { value, done } = await reader.read()
        if (done) break
        if (ac.signal.aborted) return
        const ab = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        ) as ArrayBuffer & { fileStart: number }
        ab.fileStart = this.fileOffset
        this.fileOffset += value.byteLength
        this.file.appendBuffer(ab)
        if (!this.moovFound && this.fileOffset > HEAD_LIMIT) {
          throw new Error('moov not found in the head — likely not faststart')
        }
      }
      if (!ac.signal.aborted) {
        try { this.file.flush() } catch { /* tail garbage */ }
        this.demuxDone = true
        this.finishSkip()
        this.feed()
        this.kick()
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        if (!this.ready) this.headReject?.(err as Error)
        else this.fatal = true
        this.kick()
      }
    }
  }

  private feed() {
    const dec = this.decoder
    if (!dec || dec.state !== 'configured') return
    while (this.pendingChunks.length && dec.decodeQueueSize < 20 && this.outFrames.length < 10) {
      dec.decode(this.pendingChunks.shift()!)
    }
    if (this.demuxDone && !this.pendingChunks.length && !this.flushing) {
      this.flushing = true
      dec
        .flush()
        .then(() => {
          this.flushedAll = true
          this.kick()
        })
        .catch(() => { /* aborted by a jump — jump() resets the flags */ })
    }
  }

  /** Reset decode state shared by both jump flavours. */
  private resetForJump() {
    this.fetchAbort?.abort()
    for (const f of this.outFrames) f.close()
    this.outFrames = []
    this.pendingChunks = []
    this.gopBuffer = []
    this.skipTargetUs = null
    this.current?.close()
    this.current = null
    this.ahead?.close()
    this.ahead = null
    this.demuxDone = false
    this.flushing = false
    this.flushedAll = false
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.makeDecoder()
  }

  /** Restart demux+decode at the keyframe before srcT (loop wrap, far seek). */
  private jump(srcT: number) {
    if (this.fragmented) {
      this.jumpFragmented(srcT)
      return
    }
    this.resetForJump()
    this.file.stop()
    // seek in unshifted media time so the chosen keyframe is never late
    const shiftSec = this.sampleScale > 0 ? this.ctsShift / this.sampleScale : 0
    const si = this.file.seek(Math.max(0, srcT + shiftSec), true)
    this.file.start()
    void this.pump(si.offset)
  }

  /**
   * mp4box cannot seek fragmented streams: moov carries no sample table and
   * extraction cannot rewind into data it has already discarded. Restart with
   * a fresh ISOFile from byte 0 instead; ingestSamples() demux-skips (no
   * decode) everything before the last keyframe at or before srcT.
   */
  private jumpFragmented(srcT: number) {
    this.resetForJump()
    try { this.file.stop() } catch { /* replaced below */ }
    const file = MP4Box.createFile()
    this.file = file
    file.onError = () => {
      this.fatal = true
      this.kick()
    }
    file.onSamples = (_id: number, _u: unknown, samples: Sample[]) =>
      this.ingestSamples(file, samples)
    file.onReady = () => {
      try {
        file.setExtractionOptions(this.trackId, null, { nbSamples: 30 })
        file.start()
      } catch {
        this.fatal = true
        this.kick()
      }
    }
    this.skipTargetUs = srcT > 0 ? srcT * 1e6 : null
    void this.pump(0)
  }

  /**
   * The frame covering source time srcT (seconds). Returned frames stay
   * owned by the source: valid until the next frameAt()/close() call.
   */
  async frameAt(srcT: number): Promise<VideoFrame | null> {
    const target = Math.max(0, srcT) * 1e6
    if (!this.started) {
      this.started = true
      // deep in-points skip straight to the nearest keyframe
      if (target > 2e6) this.jump(srcT)
    } else if (this.current && target < this.current.timestamp - 100_000) {
      this.jump(srcT) // backward (a looping clip wrapped around)
    }
    for (let guard = 0; guard < 100_000; guard++) {
      if (this.fatal) throw new Error('webcodecs decode failed')
      if (this.current) {
        const end = this.current.timestamp + (this.current.duration ?? 40_000)
        if (target < end) {
          // keep the successor on hand for frame blending; wait for it
          // unless the stream is over (the tail frame stands alone)
          if (!this.ahead) {
            if (this.outFrames.length) {
              this.ahead = await this.normalizeColor(this.outFrames.shift()!)
              this.feed()
            } else if (!this.flushedAll) {
              this.feed()
              await this.wait()
              continue
            }
          }
          return this.current
        }
        // advance to the successor
        if (this.ahead) {
          this.current.close()
          this.current = this.ahead
          this.ahead = null
          continue
        }
        if (this.outFrames.length) {
          this.current.close()
          this.current = await this.normalizeColor(this.outFrames.shift()!)
          this.feed()
          continue
        }
        if (this.flushedAll) return this.current // freeze on the tail
      } else {
        if (this.outFrames.length) {
          this.current = await this.normalizeColor(this.outFrames.shift()!)
          this.feed()
          continue
        }
        // a stream that never produced a single frame is a broken source —
        // throwing here flips the exporter to the element-seek fallback
        if (this.flushedAll) throw new Error('demux produced no frames')
      }
      this.feed()
      await this.wait()
    }
    throw new Error('frame search did not converge')
  }

  /**
   * The frame following the last frameAt() result, when already decoded.
   * Same ownership rules as frameAt: valid until the next frameAt()/close().
   */
  next(): VideoFrame | null {
    return this.ahead
  }

  /**
   * Untagged streams: <video> and WebCodecs guess the YUV matrix differently
   * (BT.601 vs BT.709), which would shift export colors away from what the
   * preview shows. Re-wrap such frames with the same heuristic the element
   * pipeline uses — HD gets BT.709, SD gets BT.601. Tagged frames pass as-is.
   */
  private async normalizeColor(f: VideoFrame): Promise<VideoFrame> {
    const cs = f.colorSpace
    if ((cs && cs.matrix) || !f.format) return f
    try {
      const size = f.allocationSize()
      if (!this.scratch || this.scratch.byteLength < size) this.scratch = new Uint8Array(size)
      const buf = this.scratch.subarray(0, size)
      const layout = await f.copyTo(buf)
      const hd = (f.codedHeight ?? 0) >= 720
      const nf = new VideoFrame(buf, {
        format: f.format,
        codedWidth: f.codedWidth,
        codedHeight: f.codedHeight,
        timestamp: f.timestamp,
        duration: f.duration ?? undefined,
        layout,
        visibleRect: f.visibleRect ?? undefined,
        displayWidth: f.displayWidth,
        displayHeight: f.displayHeight,
        colorSpace: hd
          ? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
          : { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false }
      })
      f.close()
      return nf
    } catch {
      return f // odd pixel format — better untouched than broken
    }
  }

  close() {
    this.fetchAbort?.abort()
    for (const f of this.outFrames) f.close()
    this.outFrames = []
    this.pendingChunks = []
    this.gopBuffer = []
    this.current?.close()
    this.current = null
    this.ahead?.close()
    this.ahead = null
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    } catch { /* already closed */ }
    this.kick()
  }
}
