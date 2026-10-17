import { useState } from 'react'
import { intercomAudio } from '../../services/buzzer'
import { VIBRATION_LIMITS, clampVibration, hapticMode, playVibration, vibrationPattern } from '../../services/vibration'
import { vibrationLengthMs, type Cue } from '../../types/cue'
import { Label, NumberField } from '../ui/controls'

type Fields = Pick<Cue, 'vibrationCount' | 'vibrationDuration' | 'vibrationInterval'>

/** Pulse count / length / pause with a picture of the rhythm and a Test button that uses this device's mechanism. */
export function HapticEditor({ value, onChange }: { value: Fields; onChange: (changes: Partial<Fields>) => void }) {
  const [note, setNote] = useState<string | null>(null)
  const pattern = vibrationPattern(value)
  const total = Math.max(1, vibrationLengthMs(clampVibration(value)))
  const mode = hapticMode()

  const test = () => {
    // Inside the tap: creates / resumes the AudioContext too (the iPhone fallback needs it).
    const result = playVibration(value, intercomAudio())
    setNote(
      result === 'vibrate'
        ? '✓ 已用手機震動馬達播放（Android）'
        : result === 'audio'
          ? '✓ 這台裝置不支援網頁震動（iPhone / iPad）：已改用低頻「咚咚」聲模擬；鎖屏或背景時改由推播通知提醒'
          : '⚠ 這台裝置無法震動，也還沒解鎖聲音：請再點一次，或確認不是靜音模式',
    )
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-white/[0.03] p-3" data-haptic-editor>
      <Label hint={mode === 'vibrate' ? '本機：手機震動' : '本機：iOS 低頻聲模擬'}>📳 震動與推播設定</Label>
      <div className="grid grid-cols-3 gap-2">
        <NumberField
          compact
          label="連續次數"
          suffix="次"
          step={1}
          min={VIBRATION_LIMITS.count[0]}
          max={VIBRATION_LIMITS.count[1]}
          value={value.vibrationCount}
          onChange={(v) => onChange({ vibrationCount: Math.round(v) })}
        />
        <NumberField
          compact
          label="單次震動"
          suffix="ms"
          step={50}
          min={VIBRATION_LIMITS.duration[0]}
          max={VIBRATION_LIMITS.duration[1]}
          value={value.vibrationDuration}
          onChange={(v) => onChange({ vibrationDuration: Math.round(v) })}
        />
        <NumberField
          compact
          label="間隔"
          suffix="ms"
          step={50}
          min={VIBRATION_LIMITS.interval[0]}
          max={VIBRATION_LIMITS.interval[1]}
          value={value.vibrationInterval}
          onChange={(v) => onChange({ vibrationInterval: Math.round(v) })}
        />
      </div>
      {/* The rhythm: filled = vibrating, gap = pause */}
      <div className="flex h-6 w-full overflow-hidden rounded-md bg-black/40" aria-label="震動節奏">
        {pattern.map((ms, i) => (
          <span key={i} className={i % 2 === 0 ? 'bg-standby' : 'bg-transparent'} style={{ width: `${(ms / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-white/50">
          總長 {(vibrationLengthMs(clampVibration(value)) / 1000).toFixed(2)} s
        </span>
        <span className="flex-1" />
        <button type="button" onClick={test} className="min-h-11 rounded-xl bg-standby px-5 text-sm font-bold text-black active:brightness-90" data-haptic-test>
          測試震動 (Test Haptic)
        </button>
      </div>
      {note && <p className="text-xs leading-relaxed text-white/60">{note}</p>}
      <p className="text-[11px] leading-relaxed text-white/35">
        Android：前景用手機震動，背景由推播通知震動。iPhone / iPad：沒有網頁震動，前景用低頻聲模擬；要在鎖屏／背景收到提醒，請先「加入主畫面」並允許通知。
      </p>
    </div>
  )
}
