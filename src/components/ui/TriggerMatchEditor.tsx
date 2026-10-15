import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { inputBus } from '../../services/inputBus'
import { midi, useMidi } from '../../services/midi'
import { oscBridge, useOscBridge } from '../../services/oscBridge'
import { defaultMatch, describeEvent, matchFromEvent, midiCondition, type CcMode, type TriggerMatch } from '../../types/trigger'
import { Label, NumberField, Segmented, fieldClass } from './controls'
import { ImeInput } from './ImeText'

const LEARN_TIMEOUT_MS = 20_000
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** MIDI note number → name, with middle C (60) = C4. */
const noteName = (n: number) => `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`

type MidiMatch = Extract<TriggerMatch, { source: 'midi' }>

/**
 * Edit which incoming OSC/MIDI signal a trigger listens for, including the MIDI value condition
 * (Note On velocity, CC threshold or range). "Learn" captures the next signal that arrives and
 * fills channel and note/controller in.
 */
export function TriggerMatchEditor({ match, onChange }: { match: TriggerMatch; onChange: (match: TriggerMatch) => void }) {
  const [learning, setLearning] = useState(false)
  const [learned, setLearned] = useState<string | null>(null)
  const midiState = useMidi()
  const bridge = useOscBridge()
  // Parents pass inline callbacks; keep the latest so Learn registers once per click.
  const latest = useRef({ match, onChange })
  useEffect(() => {
    latest.current = { match, onChange }
  })

  useEffect(() => {
    if (!learning) return
    // Make sure there is something to learn from.
    midi.connect()
    oscBridge.connect()
    const cancel = inputBus.learn((event) => {
      latest.current.onChange(matchFromEvent(event, latest.current.match))
      setLearned(describeEvent(event))
      setLearning(false)
    })
    const timeout = setTimeout(() => setLearning(false), LEARN_TIMEOUT_MS)
    return () => {
      cancel()
      clearTimeout(timeout)
    }
  }, [learning])

  useEffect(() => {
    if (!learned) return
    const timer = setTimeout(() => setLearned(null), 4000)
    return () => clearTimeout(timer)
  }, [learned])

  const setMidi = (changes: Partial<MidiMatch>) => {
    if (match.source !== 'midi') return
    // Firebase rejects undefined values, so drop keys being cleared.
    const next = { ...match, ...changes } as Record<string, unknown>
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
    onChange(next as MidiMatch)
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <Segmented<TriggerMatch['source']>
            columns={2}
            value={match.source}
            onChange={(source) => source !== match.source && onChange(defaultMatch(source))}
            options={[
              { id: 'midi', label: '🎹 MIDI' },
              { id: 'osc', label: '📡 OSC' },
            ]}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setLearned(null)
            setLearning(!learning)
          }}
          className={`min-h-11 shrink-0 rounded-lg px-4 text-xs font-semibold transition ${
            learning ? 'animate-pulse bg-standby text-black' : 'bg-white/[0.07] text-white/75 hover:bg-white/15'
          }`}
          title="等待下一個收到的 MIDI / OSC 訊號並自動填入（再按一次取消）"
        >
          {learning ? '等待訊號… 取消' : '🎯 Learn'}
        </button>
      </div>

      <AnimatePresence>
        {(learning || learned) && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className={`overflow-hidden rounded-lg px-3 py-2 text-xs ${learned ? 'bg-go/15 text-go' : 'bg-standby/10 text-standby'}`}
          >
            {learned
              ? `✓ 已學習：${learned}`
              : `請操作外部設備（按下按鍵 / 推動推桿）…${
                  midiState.status === 'unsupported'
                    ? '（此瀏覽器不支援 MIDI，僅能學習 OSC）'
                    : midiState.status === 'ready' && midiState.inputs.length === 0
                      ? '（沒有偵測到 MIDI 輸入裝置）'
                      : ''
                }${bridge.status !== 'connected' ? '（OSC Bridge 未連線）' : ''}`}
          </motion.p>
        )}
      </AnimatePresence>

      {match.source === 'osc' ? (
        <label className="block">
          <Label hint="完全相符">OSC Address</Label>
          <ImeInput
            className={`${fieldClass} font-mono`}
            value={match.address}
            placeholder="/sys/go"
            onValueChange={(address) => onChange({ ...match, address: address.trim() })}
          />
          <span className="mt-1 block text-[10px] text-white/30">第一個參數為 0 / false 時視為放開，不觸發</span>
        </label>
      ) : (
        <MidiFields match={match} setMidi={setMidi} />
      )}
    </div>
  )
}

function MidiFields({ match, setMidi }: { match: MidiMatch; setMidi: (changes: Partial<MidiMatch>) => void }) {
  const condition = midiCondition(match)
  const int = (v: number) => Math.round(v)

  return (
    <div className="space-y-3">
      <Segmented<'noteOn' | 'cc'>
        columns={2}
        value={match.message}
        onChange={(message) =>
          setMidi(
            message === 'noteOn'
              ? { message, minValue: 1, ccMode: undefined, maxValue: undefined }
              : { message, ccMode: 'rise', minValue: 64, maxValue: 127 },
          )
        }
        options={[
          { id: 'noteOn', label: 'Note On' },
          { id: 'cc', label: 'Control Change' },
        ]}
      />

      {/* Side by side when there's room; stacked rather than squeezed when there isn't. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
        <NumberField
          label="Channel"
          hint={match.channel === 0 ? '0 = 任意' : `Ch ${match.channel}`}
          suffix=""
          step={1}
          stepperStep={1}
          max={16}
          value={match.channel}
          onChange={(v) => setMidi({ channel: int(v) })}
        />
        <NumberField
          label={match.message === 'cc' ? 'CC #' : 'Note'}
          hint={match.message === 'noteOn' ? noteName(match.number) : undefined}
          suffix=""
          step={1}
          stepperStep={1}
          max={127}
          value={match.number}
          onChange={(v) => setMidi({ number: int(v) })}
        />
      </div>

      {match.message === 'noteOn' ? (
        <NumberField
          label="Velocity ≥"
          hint={condition.min <= 1 ? '任何 Note On' : `力度至少 ${condition.min}`}
          suffix=""
          step={1}
          stepperStep={1}
          min={1}
          max={127}
          value={condition.min}
          onChange={(v) => setMidi({ minValue: int(v) })}
        />
      ) : (
        <div className="space-y-3">
          <div>
            <Label>觸發條件</Label>
            <Segmented<CcMode>
              columns={2}
              value={condition.mode as CcMode}
              onChange={(ccMode) => setMidi({ ccMode, minValue: 64, maxValue: 127 })}
              options={[
                { id: 'rise', label: '數值升到 ≥', description: '由下往上越過門檻' },
                { id: 'range', label: '數值區間', description: '進入區間時' },
              ]}
            />
          </div>
          {condition.mode === 'rise' ? (
            <NumberField
              label="Value ≥"
              hint={`升到 ${condition.min} 以上時`}
              suffix=""
              step={1}
              stepperStep={1}
              min={1}
              max={127}
              value={condition.min}
              onChange={(v) => setMidi({ minValue: int(v) })}
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
              <NumberField
                label="Value 最小"
                suffix=""
                step={1}
                stepperStep={1}
                max={condition.max}
                value={condition.min}
                onChange={(v) => setMidi({ minValue: int(v) })}
              />
              <NumberField
                label="Value 最大"
                suffix=""
                step={1}
                stepperStep={1}
                min={condition.min}
                max={127}
                value={condition.max}
                onChange={(v) => setMidi({ maxValue: int(v) })}
              />
            </div>
          )}
          <p className="text-[10px] text-white/30">
            {condition.mode === 'rise'
              ? '推桿來回推過門檻時，只會在往上越過的那一刻觸發一次。'
              : `數值從區間外進入 ${condition.min}–${condition.max} 時觸發一次。`}
          </p>
        </div>
      )}
    </div>
  )
}
