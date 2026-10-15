import { useEffect, useSyncExternalStore } from 'react'
import type { MidiMessage } from '../types/surface'
import { inputBus } from './inputBus'

/**
 * Web MIDI output. Requires Chrome/Edge (Safari has no Web MIDI) and a secure context
 * (https or localhost). The chosen output is remembered per computer in localStorage,
 * since MIDI devices are local hardware, not project data.
 */

export interface MidiOutputInfo {
  id: string
  name: string
  manufacturer: string
}

type MidiStatus = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied'

const OUTPUT_KEY = 'theatre.midiOutputId'

const readStored = () => {
  try {
    return localStorage.getItem(OUTPUT_KEY)
  } catch {
    return null
  }
}

class MidiService {
  private access: MIDIAccess | null = null
  private listeners = new Set<() => void>()
  status: MidiStatus = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'idle' : 'unsupported'
  error: string | null = null
  outputs: MidiOutputInfo[] = []
  /** Connected input devices; every one of them is listened to. */
  inputs: MidiOutputInfo[] = []
  selectedId: string | null = readStored()
  /** Snapshot object for useSyncExternalStore; replaced on every change. */
  snapshot = this.makeSnapshot()

  private makeSnapshot() {
    return { status: this.status, error: this.error, outputs: this.outputs, inputs: this.inputs, selectedId: this.selectedId }
  }

  private emit() {
    this.snapshot = this.makeSnapshot()
    this.listeners.forEach((l) => l())
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Ask the browser for MIDI access (shows a permission prompt the first time). */
  async connect() {
    if (this.status === 'unsupported' || this.status === 'requesting' || this.access) return
    this.status = 'requesting'
    this.emit()
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => this.refresh()
      this.status = 'ready'
      this.refresh()
    } catch (err) {
      this.status = 'denied'
      this.error = (err as Error).message
      this.emit()
    }
  }

  /** Re-read device lists (plugged in or removed) and (re)attach input listeners. */
  private refresh() {
    if (!this.access) return
    const connectedInputs = [...this.access.inputs.values()].filter((i) => i.state === 'connected')
    for (const input of connectedInputs) input.onmidimessage = (e) => this.handleInput(input.name ?? input.id, e)
    this.inputs = connectedInputs.map((i) => ({ id: i.id, name: i.name ?? i.id, manufacturer: i.manufacturer ?? '' }))
    this.outputs = [...this.access.outputs.values()]
      .filter((o) => o.state === 'connected')
      .map((o) => ({ id: o.id, name: o.name ?? o.id, manufacturer: o.manufacturer ?? '' }))
    // Fall back to the first device when the remembered one isn't connected.
    if (!this.outputs.some((o) => o.id === this.selectedId)) this.selectedId = this.outputs[0]?.id ?? null
    this.emit()
  }

  /** Decode Note On/Off and CC and publish them; clock, sensing and sysex are ignored. */
  private handleInput(device: string, event: MIDIMessageEvent) {
    const data = event.data
    if (!data || data.length < 3) return
    const status = data[0]
    const kind = status & 0xf0
    const channel = (status & 0x0f) + 1
    const number = Number(data[1])
    const value = Number(data[2])
    const message: 'noteOn' | 'noteOff' | 'cc' | null =
      kind === 0x90 && value > 0 ? 'noteOn' : kind === 0x80 || (kind === 0x90 && value === 0) ? 'noteOff' : kind === 0xb0 ? 'cc' : null

    // Full packet structure for rehearsal debugging (DevTools → Console).
    console.log(
      `[MIDI in] ${message ?? 'other'} · ch ${channel} · ${message === 'cc' ? 'controller' : 'note'} ${number} · ${message === 'cc' ? 'value' : 'velocity'} ${value}`,
      {
        device,
        bytes: [...data].map((b) => b.toString(16).padStart(2, '0')).join(' '),
        status: `0x${status.toString(16)}`,
        command: message ?? `0x${kind.toString(16)}`,
        channel,
        [message === 'cc' ? 'controller' : 'note']: number,
        [message === 'cc' ? 'value' : 'velocity']: value,
      },
    )
    if (message) inputBus.emit({ source: 'midi', message, channel, number, value, device, at: Date.now() })
  }

  select(id: string) {
    this.selectedId = id
    try {
      localStorage.setItem(OUTPUT_KEY, id)
    } catch {
      // Storage blocked: selection lasts for this session only.
    }
    this.emit()
  }

  /**
   * Send one message on the selected output. Channel is 1–16; number/value are 0–127.
   * Returns false when there is no usable output.
   */
  send(message: MidiMessage, channel: number, number: number, value: number): boolean {
    const output = this.selectedId ? this.access?.outputs.get(this.selectedId) : undefined
    if (!output) return false
    const ch = Math.min(15, Math.max(0, Math.round(channel) - 1))
    const clamp = (n: number) => Math.min(127, Math.max(0, Math.round(n)))
    switch (message) {
      case 'noteOn':
        output.send([0x90 | ch, clamp(number), clamp(value)])
        break
      case 'noteOff':
        output.send([0x80 | ch, clamp(number), 0])
        break
      case 'cc':
        output.send([0xb0 | ch, clamp(number), clamp(value)])
        break
      case 'program':
        output.send([0xc0 | ch, clamp(number)])
        break
    }
    return true
  }
}

export const midi = new MidiService()

export function useMidi() {
  const state = useSyncExternalStore(midi.subscribe, () => midi.snapshot)
  return { ...state, connect: () => midi.connect(), select: (id: string) => midi.select(id) }
}

/** Connect automatically once a surface that uses MIDI is open (connect() is a no-op once connected). */
export function useAutoConnectMidi(enabled: boolean) {
  useEffect(() => {
    if (enabled) midi.connect()
  }, [enabled])
}
