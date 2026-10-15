import { refuseIfReadOnly } from '../services/projectLock'
import { onValue, push, ref, remove, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { db } from '../services/firebase'
import { DEFAULT_EQ, DEFAULT_INPUT, type StudioEq, type StudioTrack, type TrackInput } from '../types/studio'

/** Everything a channel-strip preset sets on a track. */
export interface StripSettings {
  input: TrackInput
  volume: number
  pan: number
  reverb: number
  eq: StudioEq
  compressor: boolean
  highpass: number
}

export interface StripPreset {
  id: string
  name: string
  builtin: boolean
  settings: StripSettings
}

const base: StripSettings = { input: DEFAULT_INPUT, volume: 1, pan: 0, reverb: 0, eq: DEFAULT_EQ, compressor: false, highpass: 0 }
const preset = (id: string, name: string, s: Partial<Omit<StripSettings, 'input'>> & { input?: Partial<TrackInput> }): StripPreset => ({
  id,
  name,
  builtin: true,
  settings: { ...base, ...s, input: { ...DEFAULT_INPUT, ...s.input, tuner: { ...DEFAULT_INPUT.tuner, ...s.input?.tuner } } },
})

export const BUILTIN_PRESETS: StripPreset[] = [
  preset('clean', '原音 Clean', {}),
  preset('loud-clear', 'Loud and Clear 清晰響亮', { input: { preGain: 6, noiseRemoval: true }, volume: 1.12, reverb: 0.1, eq: { low: -2, mid: -2, midFreq: 400, high: 4 }, compressor: true, highpass: 90 }),
  preset('warm', 'Warm Voice 溫暖人聲', { input: { preGain: 3 }, reverb: 0.16, eq: { low: 3, mid: -2, midFreq: 2500, high: -1 }, compressor: true, highpass: 60 }),
  preset('narration', 'Narration 旁白廣播', { input: { preGain: 6, noiseRemoval: true }, eq: { low: -1, mid: 2, midFreq: 3000, high: 2 }, compressor: true, highpass: 100 }),
  preset('hall', 'Big Hall 大廳', { input: { preGain: 3 }, reverb: 0.55, eq: { low: -2, mid: 0, midFreq: 1000, high: 2 } }),
  preset('pitch', 'Pitch Perfect 自然修音', { input: { noiseRemoval: true, tuner: { enabled: true, realtime: true, mode: 'natural', key: '', amount: 0.7 } }, reverb: 0.15, compressor: true }),
  preset('robot', 'Robot Voice 機器人', { input: { tuner: { enabled: true, realtime: true, mode: 'robotic', key: '0:major', amount: 1 } }, reverb: 0.1, eq: { low: -4, mid: 4, midFreq: 1800, high: 2 }, compressor: true }),
  preset('phone', 'Telephone 電話', { input: { preGain: 3 }, eq: { low: -18, mid: 6, midFreq: 1500, high: -12 }, compressor: true, highpass: 450 }),
]

/** Custom presets saved by the team for this show: projects/{pid}/studioPresets/{id}. */
const presetsPath = (projectId: string) => `projects/${projectId}/studioPresets`

export function useStripPresets(projectId: string) {
  const [custom, setCustom] = useState<StripPreset[]>([])
  useEffect(
    () =>
      onValue(ref(db, presetsPath(projectId)), (snap) => {
        const raw = (snap.val() ?? {}) as Record<string, { name: string; settings: StripSettings }>
        setCustom(Object.entries(raw).map(([id, p]) => ({ id, name: p.name, builtin: false, settings: { ...base, ...p.settings, input: { ...DEFAULT_INPUT, ...p.settings?.input } } })))
      }),
    [projectId],
  )
  return custom
}

export async function saveStripPreset(projectId: string, name: string, settings: StripSettings) {
  if (refuseIfReadOnly(projectId)) throw new Error('read-only')
  const node = push(ref(db, presetsPath(projectId)))
  await set(node, { name, settings, createdAt: Date.now() })
  return node.key!
}

export const deleteStripPreset = (projectId: string, id: string) =>
  refuseIfReadOnly(projectId) ? Promise.reject(new Error('read-only')) : remove(ref(db, `${presetsPath(projectId)}/${id}`))

/** A track's current channel-strip settings (for "Save Preset…"). */
export const stripOf = (t: StudioTrack): StripSettings => ({
  input: t.input,
  volume: t.volume,
  pan: t.pan,
  reverb: t.fx.reverb,
  eq: t.eq,
  compressor: t.fx.compressor,
  highpass: t.fx.highpass,
})
