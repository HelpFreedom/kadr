import type { ExportPreset } from '@shared/types'

export const PRESETS: ExportPreset[] = [
  {
    id: 'yt1080',
    name: 'YouTube 1080p (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 1920,
    height: 1080,
    fps: 'project',
    videoBitrate: 10_000_000,
    audioCodec: 'aac',
    audioBitrate: '192k'
  },
  {
    id: 'yt4k',
    name: 'YouTube 4K (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 3840,
    height: 2160,
    fps: 'project',
    videoBitrate: 40_000_000,
    audioCodec: 'aac',
    audioBitrate: '256k'
  },
  {
    id: 'vertical',
    name: 'Shorts/Reels 1080×1920',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 1080,
    height: 1920,
    fps: 'project',
    videoBitrate: 9_000_000,
    audioCodec: 'aac',
    audioBitrate: '192k'
  },
  {
    id: 'hd720',
    name: '720p (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 1280,
    height: 720,
    fps: 'project',
    videoBitrate: 5_000_000,
    audioCodec: 'aac',
    audioBitrate: '160k'
  },
  {
    id: 'source',
    name: 'Project size (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 'project',
    height: 'project',
    fps: 'project',
    videoBitrate: 12_000_000,
    audioCodec: 'aac',
    audioBitrate: '192k'
  },
  {
    id: 'webm',
    name: 'WebM VP9 (re-encode)',
    container: 'webm',
    codec: 'avc',
    ffmpegVideo: 'libvpx-vp9',
    width: 'project',
    height: 'project',
    fps: 'project',
    videoBitrate: 4_000_000,
    audioCodec: 'libopus',
    audioBitrate: '160k'
  },
  {
    id: 'mp3',
    name: 'MP3 (только аудио / audio only)',
    container: 'mp3',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 'project',
    height: 'project',
    fps: 'project',
    videoBitrate: 0,
    audioCodec: 'libmp3lame',
    audioBitrate: '320k',
    audioOnly: true
  }
]
