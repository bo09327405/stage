import { useState } from 'react'
import { useMidi } from '../../services/midi'
import { oscBridge, useOscBridge } from '../../services/oscBridge'
import type { Surface } from '../../types/surface'
import { Label, fieldClass } from '../ui/controls'

interface SignalSettingsProps {
  surface: Surface
  onSurfaceTarget: (host: string, port: number) => void
  onClose: () => void
}

const STATUS_STYLE = {
  connected: 'bg-go/15 text-go',
  connecting: 'bg-standby/15 text-standby',
  error: 'bg-panic/15 text-panic',
  disconnected: 'bg-white/10 text-white/50',
} as const

/** Global OSC (bridge + default target) and MIDI output settings. */
export function SignalSettings({ surface, onSurfaceTarget, onClose }: SignalSettingsProps) {
  const bridge = useOscBridge()
  const midiState = useMidi()
  const [url, setUrl] = useState(bridge.settings.url)
  const [token, setToken] = useState(bridge.settings.token)
  const [host, setHost] = useState(surface.oscHost)
  const [port, setPort] = useState(String(surface.oscPort || ''))
  const [testAddress, setTestAddress] = useState('/test')

  const bridgeDirty = url !== bridge.settings.url || token !== bridge.settings.token
  const targetDirty = host !== surface.oscHost || Number(port) !== surface.oscPort

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <div className="text-[11px] font-semibold tracking-widest text-white/40 uppercase">Signal Settings</div>
          <div className="text-lg font-semibold">OSC / MIDI 全域設定</div>
        </div>
        <button
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
          aria-label="關閉"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
        {/* OSC bridge */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wider text-white/60">① OSC Bridge（本機中繼伺服器）</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[bridge.status]}`}>
              {{ connected: '● 已連線', connecting: '連線中…', error: '○ 錯誤', disconnected: '○ 未連線' }[bridge.status]}
            </span>
          </div>
          <label className="block">
            <Label hint="此電腦專用設定">Bridge 位址</Label>
            <input className={`${fieldClass} font-mono text-xs`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://localhost:8765" />
          </label>
          <label className="block">
            <Label hint="對應 OSC_BRIDGE_TOKEN，可留空">Token</Label>
            <input className={`${fieldClass} font-mono text-xs`} value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => {
                oscBridge.updateSettings({ url: url.trim(), token: token.trim() })
                oscBridge.connect()
              }}
              className="min-h-11 flex-1 rounded-lg bg-accent px-4 text-sm font-semibold text-white"
            >
              {bridgeDirty ? '儲存並連線' : bridge.status === 'connected' ? '重新連線' : '連線'}
            </button>
            {bridge.status !== 'disconnected' && (
              <button onClick={() => oscBridge.disconnect()} className="min-h-11 rounded-lg bg-white/[0.07] px-4 text-sm text-white/70">
                中斷
              </button>
            )}
          </div>
          {bridge.error && <p className="text-xs text-panic">{bridge.error}</p>}
          <p className="text-[11px] leading-relaxed text-white/35">
            在要送出 OSC 的電腦執行 <code className="rounded bg-white/10 px-1">npm run osc</code>。平板操作時，把位址改成那台電腦的區網或 Tailscale IP，例如{' '}
            <code className="rounded bg-white/10 px-1">ws://100.101.102.103:8765</code>。
          </p>
        </section>

        {/* Default OSC target */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wider text-white/60">② 預設 OSC 目標（存在此控台，團隊共用）</h3>
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <label className="block">
              <Label hint="支援 Tailscale 100.x IP">目標 IP</Label>
              <input className={`${fieldClass} font-mono text-xs`} value={host} onChange={(e) => setHost(e.target.value)} placeholder="例如 192.168.1.20" />
            </label>
            <label className="block">
              <Label>Port</Label>
              <input
                className={`${fieldClass} font-mono text-xs`}
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                placeholder="53000"
              />
            </label>
          </div>
          <button
            disabled={!targetDirty}
            onClick={() => onSurfaceTarget(host.trim(), Number(port) || 0)}
            className="min-h-11 w-full rounded-lg bg-white/[0.08] text-sm text-white/80 disabled:opacity-35"
          >
            {targetDirty ? '儲存預設目標' : '已儲存'}
          </button>
          <p className="text-[11px] text-white/35">QLab 預設 port 53000；Go Button 請參考其 OSC 設定頁。</p>

          <div className="flex gap-2">
            <input className={`${fieldClass} font-mono text-xs`} value={testAddress} onChange={(e) => setTestAddress(e.target.value)} />
            <button
              onClick={() => oscBridge.send(surface.oscHost, surface.oscPort, testAddress, [])}
              disabled={!surface.oscHost || !surface.oscPort}
              className="min-h-11 shrink-0 rounded-lg bg-white/[0.08] px-4 text-sm text-white/80 disabled:opacity-35"
            >
              測試送出
            </button>
          </div>
        </section>

        {/* Log */}
        {bridge.log.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wider text-white/60">最近送出</h3>
            <ul className="space-y-1 font-mono text-[11px]">
              {bridge.log.slice(0, 8).map((entry) => (
                <li key={entry.at + entry.text} className={`truncate ${entry.ok ? 'text-white/55' : 'text-panic'}`}>
                  {entry.ok ? '✓' : '✕'} {entry.text}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* MIDI */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wider text-white/60">③ MIDI 輸出裝置（Web MIDI）</h3>
          {midiState.status === 'unsupported' ? (
            <p className="rounded-lg bg-white/[0.03] p-3 text-xs text-white/45">
              此瀏覽器不支援 Web MIDI（Safari / iPad 不支援）。請使用電腦版 Chrome 或 Edge，並以 https 或 localhost 開啟。
            </p>
          ) : midiState.status === 'ready' ? (
            midiState.outputs.length === 0 ? (
              <p className="rounded-lg bg-white/[0.03] p-3 text-xs text-white/45">
                找不到 MIDI 輸出裝置。接上 USB MIDI 介面，或在 macOS「音訊 MIDI 設定」啟用 IAC 驅動程式來傳給本機軟體。
              </p>
            ) : (
              <select
                className={`${fieldClass} appearance-none`}
                value={midiState.selectedId ?? ''}
                onChange={(e) => midiState.select(e.target.value)}
              >
                {midiState.outputs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.manufacturer && ` · ${o.manufacturer}`}
                  </option>
                ))}
              </select>
            )
          ) : (
            <>
              <button
                onClick={midiState.connect}
                disabled={midiState.status === 'requesting'}
                className="min-h-11 w-full rounded-lg bg-accent text-sm font-semibold text-white disabled:opacity-50"
              >
                {midiState.status === 'requesting' ? '等待瀏覽器授權…' : '啟用 MIDI'}
              </button>
              {midiState.status === 'denied' && <p className="text-xs text-panic">MIDI 存取被拒：{midiState.error}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
