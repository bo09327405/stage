import { useSyncExternalStore } from 'react'
import type { OscArg } from '../types/surface'
import { inputBus } from './inputBus'

/**
 * Browser side of the OSC bridge (osc-server.js): sends JSON over WebSocket, the bridge turns it
 * into UDP OSC. Bridge address and token are per computer (localStorage), because the bridge runs
 * on whichever machine is near the OSC targets.
 */

export interface BridgeSettings {
  /** e.g. ws://localhost:8765, or ws://100.x.y.z:8765 to reach a bridge over Tailscale. */
  url: string
  token: string
}

type BridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

const SETTINGS_KEY = 'theatre.oscBridge'
const DEFAULT_SETTINGS: BridgeSettings = { url: 'ws://localhost:8765', token: '' }

function loadSettings(): BridgeSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export interface OscLogEntry {
  at: number
  text: string
  ok: boolean
}

class OscBridgeClient {
  private socket: WebSocket | null = null
  private listeners = new Set<() => void>()
  private nextId = 1
  private pending = new Map<number, string>()
  private retryTimer: number | undefined
  private wanted = false
  settings = loadSettings()
  status: BridgeStatus = 'disconnected'
  error: string | null = null
  /** UDP port the bridge receives external OSC on (0 = not listening / unknown). */
  listenPort = 0
  /** Most recent sends and replies, newest first, for the settings panel. */
  log: OscLogEntry[] = []
  snapshot = this.makeSnapshot()

  private makeSnapshot() {
    return { settings: this.settings, status: this.status, error: this.error, log: this.log, listenPort: this.listenPort }
  }

  private emit() {
    this.snapshot = this.makeSnapshot()
    this.listeners.forEach((l) => l())
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private addLog(text: string, ok: boolean) {
    this.log = [{ at: Date.now(), text, ok }, ...this.log].slice(0, 30)
    this.emit()
  }

  updateSettings(settings: BridgeSettings) {
    this.settings = settings
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // Storage blocked: settings last for this session only.
    }
    if (this.wanted) {
      this.disconnect()
      this.connect()
    } else {
      this.emit()
    }
  }

  /** Connect and keep reconnecting (every 3 s) until disconnect() is called. */
  connect() {
    this.wanted = true
    if (this.socket) return
    clearTimeout(this.retryTimer)
    let url: URL
    try {
      url = new URL(this.settings.url)
      if (this.settings.token) url.searchParams.set('token', this.settings.token)
    } catch {
      this.status = 'error'
      this.error = `無效的 Bridge 位址：${this.settings.url}`
      return this.emit()
    }

    this.status = 'connecting'
    this.error = null
    this.emit()
    const socket = new WebSocket(url)
    this.socket = socket

    socket.onopen = () => {
      this.status = 'connected'
      this.emit()
      // Ask which UDP port the bridge listens on for incoming OSC.
      socket.send(JSON.stringify({ type: 'ping' }))
    }
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data))
        if (data.type === 'oscIn') {
          inputBus.emit({ source: 'osc', address: data.address, args: data.args ?? [], from: data.from ?? '', at: Date.now() })
          return
        }
        if (data.type === 'pong') {
          this.listenPort = data.listenPort ?? 0
          this.emit()
          return
        }
        const reply = data as { id?: number; ok: boolean; error?: string }
        const text = reply.id != null ? this.pending.get(reply.id) : undefined
        if (reply.id != null) this.pending.delete(reply.id)
        if (text) this.addLog(reply.ok ? text : `${text} — ${reply.error}`, reply.ok)
      } catch {
        // Ignore malformed replies.
      }
    }
    socket.onclose = (event) => {
      this.socket = null
      this.pending.clear()
      if (event.code === 4401) {
        this.status = 'error'
        this.error = 'Token 不正確（OSC_BRIDGE_TOKEN）'
        this.wanted = false
      } else {
        this.status = this.wanted ? 'error' : 'disconnected'
        if (this.wanted) {
          this.error = '無法連線到 OSC Bridge（是否已執行 npm run osc？）'
          this.retryTimer = window.setTimeout(() => this.connect(), 3000)
        }
      }
      this.emit()
    }
  }

  disconnect() {
    this.wanted = false
    clearTimeout(this.retryTimer)
    this.socket?.close()
    this.socket = null
    this.status = 'disconnected'
    this.emit()
  }

  /** Send one OSC message. Returns false (and logs) when the bridge isn't connected. */
  send(host: string, port: number, address: string, args: { type: OscArg['type']; value: string | number }[]) {
    const label = `${host}:${port} ${address} ${args.map((a) => `${a.type}:${a.value}`).join(' ')}`.trim()
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.addLog(`未送出（Bridge 未連線）${label}`, false)
      return false
    }
    const id = this.nextId++
    this.pending.set(id, label)
    this.socket.send(JSON.stringify({ id, type: 'osc', host, port, address, args }))
    return true
  }
}

export const oscBridge = new OscBridgeClient()

export function useOscBridge() {
  return useSyncExternalStore(oscBridge.subscribe, () => oscBridge.snapshot)
}
