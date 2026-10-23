import { Fader } from '../ui/controls'
import { describeMapping, type VjController } from '../../hooks/useVjController'

/** "M" button: map this parameter to a MIDI control / OSC address, or show and clear its mapping. */
export function LearnButton({ target, ctl }: { target: string; ctl: VjController }) {
  const mapped = ctl.mappingFor.get(target)
  const armed = ctl.learning === target
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={() => (armed ? ctl.stopLearn() : ctl.startLearn(target))}
        title={armed ? '等待訊號… 轉動旋鈕、按下按鈕或傳送 OSC（再按一次取消）' : mapped ? `已對應：${describeMapping(mapped)}（點擊重新學習）` : 'MIDI Learn：點擊後轉動旋鈕或按下按鈕'}
        className={`flex h-6 min-w-6 items-center justify-center rounded px-1 text-[10px] font-semibold transition ${
          armed ? 'animate-pulse bg-standby text-black' : mapped ? 'bg-go/20 text-go' : 'bg-white/[0.06] text-white/40 hover:bg-white/15 hover:text-white'
        }`}
        data-vj-learn={target}
      >
        {armed ? '…' : mapped ? 'M●' : 'M'}
      </button>
      {mapped && !armed && (
        <button type="button" onClick={() => ctl.removeMapping(target)} title="移除對應" className="flex h-6 w-5 items-center justify-center rounded text-[10px] text-white/30 hover:bg-white/10 hover:text-white">
          ✕
        </button>
      )}
    </span>
  )
}

/** One labelled slider (0 … 1 stored) with its readout and, in the live panel, a MIDI Learn button. */
export function VjParam({
  label,
  value,
  display,
  onChange,
  target,
  ctl,
  fill,
}: {
  label: string
  /** 0 … 1. */
  value: number
  display: string
  onChange: (value: number) => void
  /** Controller target name (types/vj.ts); omitted where mapping makes no sense (cue editor). */
  target?: string
  ctl?: VjController
  fill?: string
}) {
  return (
    <div className="flex items-center gap-2" data-vj-param={target}>
      <span className="w-14 shrink-0 truncate text-[11px] text-white/55" title={label}>
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <Fader value={value} min={0} max={1} step={0.005} onChange={onChange} label={label} fill={fill} />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[10px] text-white/45 tabular-nums">{display}</span>
      {target && ctl && <LearnButton target={target} ctl={ctl} />}
    </div>
  )
}
