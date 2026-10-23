import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { inputBus } from '../services/inputBus'
import { midi, useAutoConnectMidi } from '../services/midi'
import { publishLiveVjMix } from '../services/vjLive'
import type { InputEvent } from '../types/trigger'
import { VJ_LAYER_COUNT, applyTarget, clearLayer, newMix, oscTarget, targetKind, triggerClip, type VjClip, type VjDeck, type VjMix } from '../types/vj'
import type { useTheatreEngine } from './useTheatreEngine'

/** A hardware control (MIDI note / CC, or an OSC address) bound to a VJ parameter. */
export type VjMapping =
  | { target: string; source: 'midi'; message: 'noteOn' | 'cc'; channel: number; number: number }
  | { target: string; source: 'osc'; address: string }

const mapKey = (projectId: string) => `theatre.vjMap.${projectId}`

function readMappings(projectId: string): VjMapping[] {
  try {
    const raw = JSON.parse(localStorage.getItem(mapKey(projectId)) ?? '[]')
    return Array.isArray(raw) ? raw.filter((m): m is VjMapping => !!m && typeof m.target === 'string' && (m.source === 'midi' || m.source === 'osc')) : []
  } catch {
    return []
  }
}

const matches = (m: VjMapping, e: InputEvent) =>
  m.source === 'midi' ? e.source === 'midi' && e.message !== 'noteOff' && e.message === m.message && e.channel === m.channel && e.number === m.number : e.source === 'osc' && e.address === m.address

/** What a mapping looks like in the UI. */
export function describeMapping(m: VjMapping): string {
  return m.source === 'midi' ? `${m.message === 'cc' ? 'CC' : 'Note'} ${m.number} · ch${m.channel}` : `OSC ${m.address}`
}

/** The controller value (0 … 1) of an incoming signal. */
function signalValue(e: InputEvent): number {
  if (e.source === 'midi') return e.value / 127
  const first = e.args[0]?.value
  if (typeof first === 'boolean') return first ? 1 : 0
  const n = Number(first)
  return first == null || !Number.isFinite(n) ? 1 : Math.min(1, Math.max(0, n))
}

/**
 * The live VJ state of the console: the mix being performed (immediate locally, throttled to the audience
 * through the engine), the selected layer, and the MIDI / OSC mapping with its "learn" mode.
 */
export function useVjController({
  projectId,
  engine,
  decks,
  inputEnabled,
}: {
  projectId: string
  engine: ReturnType<typeof useTheatreEngine>
  decks: VjDeck[] | null
  /** Only one console tab acts on external signals (the trigger host), so toggles don't fire twice. */
  inputEnabled: boolean
}) {
  const [mix, setMix] = useState<VjMix>(newMix)
  const mixRef = useRef(mix)
  const [selectedLayer, setSelectedLayer] = useState(0)
  const selectedRef = useRef(0)
  const [mappings, setMappings] = useState<VjMapping[]>(() => readMappings(projectId))
  const [learning, setLearning] = useState<string | null>(null)
  const cancelLearn = useRef<(() => void) | null>(null)
  const decksRef = useRef(decks)
  const engineRef = useRef(engine)
  const lastCc = useRef(new Map<string, number>())
  useEffect(() => {
    decksRef.current = decks
    engineRef.current = engine
    selectedRef.current = selectedLayer
  })

  // Pick up a live mix that is already running (page reload, second console tab) once, when the state arrives.
  const adopted = useRef(false)
  const { loaded } = engine
  const liveMix = engine.showState.vj
  useEffect(() => {
    if (adopted.current || !loaded) return
    adopted.current = true
    if (liveMix) {
      mixRef.current = liveMix
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMix(liveMix)
    }
  }, [loaded, liveMix])

  /** Panic (or another console) turned the output off: follow it. */
  useEffect(() => {
    if (!adopted.current) return
    if (!liveMix && mixRef.current.live) {
      mixRef.current = { ...mixRef.current, live: false }
      setMix(mixRef.current)
    }
  }, [liveMix])

  useEffect(() => publishLiveVjMix(mix), [mix])

  /** Change the mix: shown at once here, sent on to the audience. */
  const update = useCallback((fn: (m: VjMix) => VjMix) => {
    const next = fn(mixRef.current)
    if (next === mixRef.current) return
    mixRef.current = next
    setMix(next)
    engineRef.current.setVj(next)
  }, [])

  const findClip = useCallback((deckId: string, slot: string): VjClip | null => decksRef.current?.find((d) => d.id === deckId)?.clips[slot] ?? null, [])

  /** Play a deck slot on the selected layer (or a given one). */
  const triggerSlot = useCallback(
    (deckId: string, slot: string, layer = selectedRef.current) => {
      const clip = findClip(deckId, slot)
      if (!clip) return
      update((m) => triggerClip(m, layer, clip, engineRef.current.serverNow()))
    },
    [findClip, update],
  )

  const clear = useCallback((layer: number) => update((m) => clearLayer(m, layer)), [update])

  /** Everything off: layers emptied and the output down. */
  const blackout = useCallback(() => update((m) => ({ ...m, live: false, layers: m.layers.map((l) => ({ ...l, clip: null, startedAt: 0 })) })), [update])

  /* ---------- hardware mapping ---------- */

  useEffect(() => {
    try {
      localStorage.setItem(mapKey(projectId), JSON.stringify(mappings))
    } catch {
      // Storage blocked: the mapping lasts for this session.
    }
  }, [projectId, mappings])

  // Someone has mapped controls: make sure MIDI access is requested.
  useAutoConnectMidi(mappings.some((m) => m.source === 'midi') || learning != null)

  const mappingsRef = useRef(mappings)
  useEffect(() => {
    mappingsRef.current = mappings
  })

  useEffect(() => {
    if (!inputEnabled) return
    return inputBus.subscribe((e) => {
      const hits: { target: string; value: number }[] = []
      // OSC defaults (/vj/layer/1/opacity …) need no learning.
      if (e.source === 'osc') {
        const t = oscTarget(e.address)
        if (t) hits.push({ target: t, value: signalValue(e) })
      }
      for (const m of mappingsRef.current) {
        if (!matches(m, e)) continue
        let value = signalValue(e)
        if (targetKind(m.target) === 'trigger' && e.source === 'midi' && e.message === 'cc') {
          // A CC knob / fader fires a trigger once when it rises through the middle, not on every step.
          const id = `${e.device}/${e.channel}/${e.number}`
          const prev = lastCc.current.get(id) ?? 0
          lastCc.current.set(id, e.value)
          if (!(prev < 64 && e.value >= 64)) continue
          value = 1
        }
        hits.push({ target: m.target, value })
      }
      for (const h of hits)
        update((m) =>
          applyTarget(m, h.target, h.value, {
            now: engineRef.current.serverNow(),
            selectedLayer: selectedRef.current,
            resolveClip: findClip,
          }),
        )
    })
  }, [inputEnabled, update, findClip])

  /** MIDI Learn: arm a parameter, then move a knob / press a pad (or send an OSC message) to bind it. */
  const startLearn = useCallback((target: string) => {
    cancelLearn.current?.()
    midi.connect()
    setLearning(target)
    cancelLearn.current = inputBus.learn((e) => {
      cancelLearn.current = null
      setLearning(null)
      if (e.source === 'midi' && e.message === 'noteOff') return
      const mapping: VjMapping = e.source === 'midi' ? { target, source: 'midi', message: e.message === 'cc' ? 'cc' : 'noteOn', channel: e.channel, number: e.number } : { target, source: 'osc', address: e.address }
      setMappings((list) => [...list.filter((m) => m.target !== target), mapping])
    })
  }, [])

  const stopLearn = useCallback(() => {
    cancelLearn.current?.()
    cancelLearn.current = null
    setLearning(null)
  }, [])

  useEffect(() => () => cancelLearn.current?.(), [])

  const removeMapping = useCallback((target: string) => setMappings((list) => list.filter((m) => m.target !== target)), [])
  const clearMappings = useCallback(() => setMappings([]), [])
  const mappingFor = useMemo(() => new Map(mappings.map((m) => [m.target, m])), [mappings])

  return {
    mix,
    update,
    selectedLayer: Math.min(selectedLayer, VJ_LAYER_COUNT - 1),
    setSelectedLayer,
    triggerSlot,
    clear,
    blackout,
    mappings,
    mappingFor,
    learning,
    startLearn,
    stopLearn,
    removeMapping,
    clearMappings,
  }
}

export type VjController = ReturnType<typeof useVjController>
