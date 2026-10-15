#!/usr/bin/env node
/**
 * OSC bridge, both directions:
 *   out: WebSocket (JSON) → UDP OSC   — the console/surface sends to QLab, Go Button, desks, etc.
 *   in:  UDP OSC → WebSocket (JSON)   — external OSC received on OSC_LISTEN_PORT is forwarded to
 *                                       every connected page, where triggers can fire cues.
 *
 * Browsers can't use UDP, which is why this small process exists.
 *
 *   npm run osc
 *
 * Environment variables:
 *   OSC_BRIDGE_PORT   WebSocket port (default 8765)
 *   OSC_BRIDGE_HOST   interface to listen on (default 0.0.0.0 so tablets on the LAN/Tailscale can reach it;
 *                     use 127.0.0.1 to accept connections from this computer only)
 *   OSC_BRIDGE_TOKEN  optional shared secret; clients must connect with ?token=<value>
 *   OSC_LISTEN_PORT   UDP port to receive external OSC on (default 8000; 0 disables listening)
 *
 * Client → bridge messages:
 *   { "id": 1, "type": "osc", "host": "100.64.0.5", "port": 53000,
 *     "address": "/go", "args": [{ "type": "f", "value": 0.5 }] }
 *   { "id": 2, "type": "ping" }
 * Bridge → client replies:
 *   { "id": 1, "ok": true }   or   { "id": 1, "ok": false, "error": "…" }
 *   { "id": 2, "ok": true, "type": "pong", "version": 2, "listenPort": 8000 }
 * Bridge → client, unsolicited, for every OSC message received on OSC_LISTEN_PORT:
 *   { "type": "oscIn", "address": "/sys/go", "args": [{ "type": "i", "value": 1 }],
 *     "from": "192.168.1.30:53001", "at": 1760000000000 }
 */
import osc from 'osc'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.OSC_BRIDGE_PORT ?? 8765)
const HOST = process.env.OSC_BRIDGE_HOST ?? '0.0.0.0'
const TOKEN = process.env.OSC_BRIDGE_TOKEN ?? ''
const LISTEN_PORT = Number(process.env.OSC_LISTEN_PORT ?? 8000)
const VERSION = 2

const ARG_TYPES = new Set(['f', 'i', 's', 'T', 'F'])

// One UDP socket for all outgoing packets; the OS picks the local port.
const udp = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: 0, metadata: true, broadcast: true })
udp.on('error', (err) => console.error('[udp] error:', err.message))
udp.open()

// Incoming OSC: a second UDP socket bound to the listen port.
let listening = false
if (LISTEN_PORT > 0) {
  const inbound = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: LISTEN_PORT, metadata: true })
  inbound.on('ready', () => {
    listening = true
    console.log(`Listening for incoming OSC on udp://0.0.0.0:${LISTEN_PORT}`)
  })
  inbound.on('message', (message, _timeTag, info) => {
    const args = (message.args ?? []).map(toJsonArg)
    const from = info ? `${info.address}:${info.port}` : 'unknown'
    console.log(`[osc] ← ${from} ${message.address} ${args.map((a) => `${a.type}:${a.value}`).join(' ')}`)
    broadcast({ type: 'oscIn', address: message.address, args, from, at: Date.now() })
  })
  inbound.on('error', (err) => {
    const hint = err.code === 'EADDRINUSE' ? `（port ${LISTEN_PORT} 已被占用，可用 OSC_LISTEN_PORT 改用其他 port）` : ''
    console.error(`[udp in] ${err.message}${hint}`)
  })
  inbound.open()
}

/** OSC arguments as plain JSON (64-bit ints, blobs, colours etc. become numbers or strings). */
function toJsonArg(arg) {
  const { type, value } = arg
  if (value == null) return { type, value: '' }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return { type, value }
  if (value instanceof Uint8Array) return { type, value: `blob(${value.length})` }
  if (typeof value.toNumber === 'function') return { type, value: value.toNumber() } // Long
  return { type, value: JSON.stringify(value) }
}

/** Send to every connected, authorised page. */
function broadcast(body) {
  const text = JSON.stringify(body)
  for (const client of wss.clients) if (client.readyState === 1) client.send(text)
}

/** Validate a client message and convert its args to osc.js typed arguments. */
function toPacket(msg) {
  if (typeof msg.address !== 'string' || !msg.address.startsWith('/')) throw new Error('address 必須以 / 開頭')
  if (typeof msg.host !== 'string' || !msg.host.trim()) throw new Error('缺少目標 host')
  const port = Number(msg.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必須是 1–65535')

  const args = (Array.isArray(msg.args) ? msg.args : []).map((arg) => {
    if (!ARG_TYPES.has(arg?.type)) throw new Error(`不支援的參數型別：${arg?.type}`)
    switch (arg.type) {
      case 'f': {
        const value = Number(arg.value)
        if (!Number.isFinite(value)) throw new Error(`float 參數不是數字：${arg.value}`)
        return { type: 'f', value }
      }
      case 'i': {
        const value = Math.round(Number(arg.value))
        if (!Number.isFinite(value)) throw new Error(`int 參數不是數字：${arg.value}`)
        return { type: 'i', value }
      }
      case 's':
        return { type: 's', value: String(arg.value ?? '') }
      default:
        return { type: arg.type, value: arg.type === 'T' }
    }
  })
  return { host: msg.host.trim(), port, packet: { address: msg.address, args } }
}

const wss = new WebSocketServer({ host: HOST, port: PORT })

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://bridge')
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    socket.close(4401, 'invalid token')
    return
  }
  const who = req.socket.remoteAddress
  console.log(`[ws] client connected from ${who}`)

  socket.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return socket.send(JSON.stringify({ ok: false, error: 'invalid JSON' }))
    }
    const reply = (body) => socket.send(JSON.stringify({ id: msg.id, ...body }))

    if (msg.type === 'ping') return reply({ ok: true, type: 'pong', version: VERSION, listenPort: listening ? LISTEN_PORT : 0 })
    if (msg.type !== 'osc') return reply({ ok: false, error: `unknown type: ${msg.type}` })

    try {
      const { host, port, packet } = toPacket(msg)
      udp.send(packet, host, port)
      const shown = packet.args.map((a) => `${a.type}:${a.value}`).join(' ')
      console.log(`[osc] → ${host}:${port} ${packet.address} ${shown}`)
      reply({ ok: true })
    } catch (err) {
      console.warn(`[osc] rejected: ${err.message}`)
      reply({ ok: false, error: err.message })
    }
  })

  socket.on('close', () => console.log(`[ws] client disconnected (${who})`))
})

wss.on('listening', () => {
  console.log(`OSC bridge listening on ws://${HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`)
  if (HOST === '0.0.0.0') console.log('  Reachable from other devices on this network / Tailscale via this computer\'s IP.')
})
wss.on('error', (err) => {
  console.error(`[ws] ${err.message}`)
  process.exit(1)
})

const shutdown = () => {
  wss.close()
  udp.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
