import { get, ref } from 'firebase/database'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { useTheatreEngine } from '../../../hooks/useTheatreEngine'
import { db } from '../../../services/firebase'
import { appendCue, assignExecutor, blankCueValues, createSequence, deleteSeqCue, deleteSequence, mergeCue, renameSequence, storeNewSequence, updateSeqCue, type CueValues } from '../../../services/sequences'
import { actionLabel } from '../../../types/actions'
import type { Cue } from '../../../types/cue'
import {
  TRIG_LABELS,
  cueAfter,
  executorNumbers,
  formatCueNumber,
  nextCueNumber,
  orderedCues,
  sourceLabel,
  type SeqCue,
  type SeqTrig,
  type Sequence,
} from '../../../types/sequence'
import type { Surface } from '../../../types/surface'
import { probeMediaDuration } from '../../../utils/probeMediaDuration'
import { InboxPickerModal } from '../../console/InboxPickerModal'
import { ActionPicker } from '../../ui/ActionPicker'
import { GridSizeMenu } from '../GridSize'
import { EXEC_GRID_PRESETS, EXEC_GRID_SLIDERS, execGridColumns, useExecGrid } from '../../../utils/execGrid'
import type { useExecutors } from './useExecutors'

/*
 * The control panel's Executor view (grandMA style):
 *   Programmer — what Store writes: a sound / Set Cue cue / show command, level, pan, timing.
 *   STORE      — then tap an executor: Append a new cue to its sequence, or Merge into a cue.
 *   Executors  — numbered strips: fader, GO, PAUSE, GO−, OFF, current / next cue.
 *   Sheet      — the selected executor's sequence: edit number, name, level, fades, delay, trig.
 */

type Engine = ReturnType<typeof useTheatreEngine>
type Exec = ReturnType<typeof useExecutors>
type Field = keyof CueValues

const ignore = () => {}
const SELECTED_KEY = 'theatre.exec.selected'

export function ExecutorView({ engine, exec, surface, projectId, cues }: { engine: Engine; exec: Exec; surface: Surface; projectId: string; cues: Cue[] }) {
  const [values, setValues] = useState<CueValues>(blankCueValues)
  const [touched, setTouched] = useState<Set<Field>>(new Set())
  const [storeArmed, setStoreArmed] = useState(false)
  const [storeTarget, setStoreTarget] = useState<number | null>(null)
  const [selected, setSelected] = useState<number>(() => {
    try {
      return Number(sessionStorage.getItem(`${SELECTED_KEY}.${surface.id}`)) || 1
    } catch {
      return 1
    }
  })
  const [sheetCue, setSheetCue] = useState<string | null>(null)
  const [grid, setGrid] = useExecGrid()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const select = (no: number) => {
    setSelected(no)
    setSheetCue(null)
    try {
      sessionStorage.setItem(`${SELECTED_KEY}.${surface.id}`, String(no))
    } catch {
      // ignore
    }
  }
  const say = (text: string, ok = true) => setMessage({ text, ok })
  useEffect(() => {
    if (!message) return
    const t = window.setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])

  // Esc leaves Store mode.
  useEffect(() => {
    if (!storeArmed) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setStoreArmed(false)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [storeArmed])

  const set = <K extends Field>(field: K, value: CueValues[K]) => {
    setValues((v) => ({ ...v, [field]: value }))
    setTouched((t) => new Set(t).add(field))
  }
  const clear = () => {
    setValues(blankCueValues())
    setTouched(new Set())
  }

  const seqOf = (no: number) => {
    const id = surface.executors[String(no)]?.sequenceId
    return (id && surface.sequences[id]) || null
  }
  const pressExec = (no: number) => {
    if (!storeArmed) return select(no)
    setStoreTarget(no)
  }
  const act = (p: Promise<unknown>) => p.catch((err: Error) => say(err.message, false))

  return (
    <div className="flex min-h-full flex-col gap-3 xl:flex-row" data-executor-view>
      <Programmer projectId={projectId} cues={cues} values={values} touched={touched} onSet={set} onClear={clear} storeArmed={storeArmed} onStore={() => setStoreArmed(!storeArmed)} message={message} />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {storeArmed && (
          <div className="flex items-center gap-3 rounded-xl border border-panic/50 bg-panic/15 px-4 py-2.5 text-sm text-panic" role="status" data-store-armed>
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-panic" />
            <b>STORE</b> — 點選要寫入的 Executor（Esc 取消）
          </div>
        )}
        <div className="-mb-1 flex items-center gap-2">
          <span className="text-[11px] font-bold tracking-[0.2em] text-white/45">EXECUTORS</span>
          <span className="ml-auto" />
          <GridSizeMenu
            value={grid}
            onChange={setGrid}
            presets={EXEC_GRID_PRESETS}
            sliders={EXEC_GRID_SLIDERS}
            note="每排數量「自動」時排成一列可左右捲動；設定數量則換行排列。與側邊欄共用此設定。"
            id="exec-page"
          />
        </div>
        <div
          className={grid.cols ? 'grid overflow-x-auto pb-1' : 'flex overflow-x-auto pb-1'}
          style={grid.cols ? { gridTemplateColumns: execGridColumns(grid), gap: grid.gap } : { gap: grid.gap }}
          data-executor-bar
        >
          {executorNumbers.map((no) => (
            <ExecutorStrip
              key={no}
              no={no}
              seq={seqOf(no)}
              engine={engine}
              exec={exec}
              cues={cues}
              selected={selected === no}
              storeArmed={storeArmed}
              onPress={() => pressExec(no)}
              onError={(t) => say(t, false)}
              scale={grid.scale}
              fill={!!grid.cols}
              width={grid.cols ? undefined : grid.col + 12}
            />
          ))}
        </div>
        <SequenceSheet
          key={selected}
          no={selected}
          seq={seqOf(selected)}
          surface={surface}
          projectId={projectId}
          engine={engine}
          exec={exec}
          cues={cues}
          selectedCue={sheetCue}
          onSelectCue={setSheetCue}
          onMessage={say}
        />
      </div>

      <AnimatePresence>
        {storeTarget != null && (
          <StoreDialog
            key="store"
            no={storeTarget}
            seq={seqOf(storeTarget)}
            running={engine.showState.executors[String(storeTarget)]?.cueId ?? null}
            sheetCue={storeTarget === selected ? sheetCue : null}
            values={values}
            touched={touched}
            onClose={() => setStoreTarget(null)}
            onDone={(text) => {
              setStoreTarget(null)
              setStoreArmed(false)
              select(storeTarget)
              say(text)
            }}
            onError={(t) => say(t, false)}
            projectId={projectId}
            surfaceId={surface.id}
            act={act}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/* ---------- programmer ---------- */

function Programmer({
  projectId,
  cues,
  values,
  touched,
  onSet,
  onClear,
  storeArmed,
  onStore,
  message,
}: {
  projectId: string
  cues: Cue[]
  values: CueValues
  touched: Set<Field>
  onSet: <K extends Field>(field: K, value: CueValues[K]) => void
  onClear: () => void
  storeArmed: boolean
  onStore: () => void
  message: { text: string; ok: boolean } | null
}) {
  const [picking, setPicking] = useState(false)
  const [projectName, setProjectName] = useState('')
  useEffect(() => {
    get(ref(db, `projectIndex/${projectId}/name`))
      .then((s) => setProjectName(String(s.val() ?? '')))
      .catch(ignore)
  }, [projectId])
  const src = values.source
  const mediaCues = cues.filter((c) => c.type === 'AUDIO' || c.type === 'VIDEO' || c.studioId)
  const pickAudio = (url: string, name: string, mediaKind: 'audio' | 'video', duration: number) => {
    onSet('source', { kind: 'audio', url, name, mediaKind })
    if (!touched.has('name')) onSet('name', name.replace(/\.[^.]+$/, ''))
    onSet('duration', duration)
    if (!duration) void probeMediaDuration(url).then((d) => d && onSet('duration', Math.round(d * 100) / 100))
  }
  const mark = (f: Field) => (touched.has(f) ? 'border-l-2 border-panic pl-2' : 'border-l-2 border-transparent pl-2')

  return (
    <section className="flex shrink-0 flex-col gap-3 rounded-2xl border border-line bg-panel/80 p-4 xl:w-80" aria-label="Programmer" data-programmer>
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-bold tracking-[0.2em] text-white/60">PROGRAMMER</h2>
        <span className="text-[10px] text-white/30">{touched.size ? `${touched.size} 項已設定` : '尚未設定'}</span>
        <button type="button" onClick={onClear} className="ml-auto h-8 rounded-lg bg-white/[0.07] px-3 text-[11px] font-bold tracking-wider text-white/70 hover:bg-white/15" data-programmer-clear>
          CLEAR
        </button>
      </div>
      <button
        type="button"
        onClick={onStore}
        className={`relative h-14 rounded-xl text-lg font-black tracking-[0.25em] shadow-[inset_0_-4px_0_rgba(0,0,0,0.35),0_6px_18px_rgba(0,0,0,0.4)] transition active:translate-y-0.5 active:shadow-[inset_0_-1px_0_rgba(0,0,0,0.35)] ${
          storeArmed ? 'animate-pulse bg-panic text-white' : 'bg-gradient-to-b from-[#ff6961] to-[#c9302c] text-white hover:brightness-110'
        }`}
        aria-pressed={storeArmed}
        title="Store：把 Programmer 寫入 Executor（先按 Store，再點 Executor）"
        data-store
      >
        STORE
      </button>
      {message && (
        <p className={`rounded-lg px-3 py-2 text-xs ${message.ok ? 'bg-go/10 text-go' : 'bg-panic/10 text-panic'}`} role="status" data-exec-message>
          {message.text}
        </p>
      )}

      <div className={mark('source')}>
        <Label>音訊 / 指令</Label>
        <div className="rounded-lg bg-black/30 px-3 py-2 text-xs" data-programmer-source={src.kind}>
          {src.kind === 'none' ? <span className="text-white/35">未選擇（存成空 Cue：只淡出上一個）</span> : <span className="text-white/85">{sourceLabel(src, cues)}</span>}
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <button type="button" onClick={() => setPicking(true)} className="h-9 rounded-lg bg-white/[0.07] text-[11px] text-white/80 hover:bg-white/15" data-programmer-pick-audio>
            🎵 音檔
          </button>
          <select
            value={src.kind === 'cue' ? src.cueId : ''}
            onChange={(e) => {
              const c = cues.find((x) => x.id === e.target.value)
              if (!c) return
              onSet('source', { kind: 'cue', cueId: c.id })
              if (!touched.has('name')) onSet('name', c.title)
              onSet('duration', c.duration || 0)
            }}
            className="h-9 min-w-0 appearance-none rounded-lg bg-white/[0.07] px-2 text-center text-[11px] text-white/80"
            aria-label="使用 Set Cue 的 Cue"
            data-programmer-pick-cue
          >
            <option value="">🎬 Set Cue</option>
            {mediaCues.map((c) => (
              <option key={c.id} value={c.id}>
                Q{c.cueNumber} {c.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => onSet('source', { kind: 'action', action: src.kind === 'action' ? src.action : 'go' })} className="h-9 rounded-lg bg-white/[0.07] text-[11px] text-white/80 hover:bg-white/15" data-programmer-pick-action>
            ⚡ 指令
          </button>
        </div>
        {src.kind === 'action' && (
          <div className="mt-1.5">
            <ActionPicker value={src.action} onChange={(a) => { onSet('source', { kind: 'action', action: a }); if (!touched.has('name')) onSet('name', actionLabel(a)) }} />
          </div>
        )}
      </div>

      <div className={mark('name')}>
        <Label>名稱</Label>
        <input value={values.name} onChange={(e) => onSet('name', e.target.value)} placeholder="Cue 名稱" className="h-9 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 text-sm outline-none focus:border-accent" data-programmer-name />
      </div>

      <div className={mark('volume')}>
        <Label right={`${Math.round(values.volume)}%`}>音量</Label>
        <input type="range" min={0} max={100} step={1} value={values.volume} onChange={(e) => onSet('volume', Number(e.target.value))} className="w-full accent-go" aria-label="音量" data-programmer-volume />
      </div>
      <div className={mark('pan')}>
        <Label right={panLabel(values.pan)}>Pan</Label>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={values.pan}
          onChange={(e) => onSet('pan', Math.abs(Number(e.target.value)) < 0.04 ? 0 : Number(e.target.value))}
          onDoubleClick={() => onSet('pan', 0)}
          className="w-full accent-accent"
          aria-label="Pan"
          title="雙擊回到中間"
          data-programmer-pan
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberBox label="Fade In" value={values.fadeIn} on={touched.has('fadeIn')} onChange={(v) => onSet('fadeIn', v)} data="fadeIn" />
        <NumberBox label="Out Fade" value={values.fadeOut} on={touched.has('fadeOut')} onChange={(v) => onSet('fadeOut', v)} data="fadeOut" />
        <NumberBox label="Delay" value={values.delay} on={touched.has('delay')} onChange={(v) => onSet('delay', v)} data="delay" />
      </div>
      <div className={`grid grid-cols-[1fr_auto] items-end gap-2 ${mark('trig')}`}>
        <div>
          <Label>Trig</Label>
          <TrigSelect value={values.trig} onChange={(t) => onSet('trig', t)} data="programmer" />
        </div>
        {values.trig === 'time' ? (
          <NumberBox label="秒" value={values.trigTime} on={touched.has('trigTime')} onChange={(v) => onSet('trigTime', v)} data="trigTime" small />
        ) : (
          <label className="flex h-9 items-center gap-1.5 text-xs text-white/60">
            <input type="checkbox" checked={values.loop} onChange={(e) => onSet('loop', e.target.checked)} className="accent-go" data-programmer-loop />
            Loop
          </label>
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-white/30">紅線標示已設定的值：Append 寫入全部設定，Merge 只覆蓋紅線的值。</p>

      <InboxPickerModal
        open={picking}
        projectId={projectId}
        projectName={projectName}
        uploads={null}
        cues={cues}
        lockKind="audio"
        onPick={(u) => {
          pickAudio(u.url, '觀眾上傳', u.kind === 'video' ? 'video' : 'audio', u.duration || 0)
          setPicking(false)
        }}
        onPickMedia={(m) => {
          pickAudio(m.url, m.name, m.kind === 'video' ? 'video' : 'audio', m.duration || 0)
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />
    </section>
  )
}

const panLabel = (p: number) => (Math.abs(p) < 0.005 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`)

function Label({ children, right }: { children: ReactNode; right?: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between text-[11px] font-semibold text-white/50">
      <span>{children}</span>
      {right && <span className="font-mono text-white/70 tabular">{right}</span>}
    </div>
  )
}

function NumberBox({ label, value, on, onChange, data, small }: { label: string; value: number; on: boolean; onChange: (v: number) => void; data: string; small?: boolean }) {
  return (
    <label className={`block ${on ? 'border-l-2 border-panic pl-2' : 'border-l-2 border-transparent pl-2'}`}>
      <span className="mb-1 block text-[11px] font-semibold text-white/50">{label}</span>
      <SecondsInput value={value} onChange={onChange} className={`h-9 rounded-lg border border-white/10 bg-black/30 px-2 text-right font-mono text-sm outline-none focus:border-accent ${small ? 'w-16' : 'w-full'}`} data={`programmer-${data}`} />
    </label>
  )
}

/** A seconds field that commits on Enter / blur (typing doesn't fight the value). */
function SecondsInput({ value, onChange, className, data, max = 3600 }: { value: number; onChange: (v: number) => void; className: string; data?: string; max?: number }) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const shown = editing ? text : String(value)
  const commit = () => {
    setEditing(false)
    const n = Number(text)
    if (Number.isFinite(n) && n !== value) onChange(Math.max(0, Math.min(max, Math.round(n * 100) / 100)))
  }
  return (
    <input
      inputMode="decimal"
      value={shown}
      onFocus={(e) => {
        setText(String(value))
        setEditing(true)
        e.currentTarget.select()
      }}
      onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={className}
      data-seconds={data}
    />
  )
}

function TrigSelect({ value, onChange, data }: { value: SeqTrig; onChange: (t: SeqTrig) => void; data: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as SeqTrig)} className="h-9 w-full appearance-none rounded-lg border border-white/10 bg-black/30 px-2 text-sm" aria-label="Trig 觸發模式" data-trig={data}>
      <option value="go">Go — 按 GO 觸發</option>
      <option value="follow">Follow — 上一個播完自動</option>
      <option value="time">Time — 上一個觸發後 n 秒</option>
    </select>
  )
}

/* ---------- executor strip ---------- */

/** One executor strip. `fill`: take the width of its grid cell (the sidebar) instead of the fixed 136 px. */
export function ExecutorStrip({
  no,
  seq,
  engine,
  exec,
  cues,
  selected,
  storeArmed,
  onPress,
  onError,
  fill = false,
  scale = 1,
  width,
}: {
  no: number
  seq: Sequence | null
  engine: Engine
  exec: Exec
  cues: Cue[]
  selected: boolean
  storeArmed: boolean
  onPress: () => void
  onError: (t: string) => void
  fill?: boolean
  /** Size of the fader and keys (1 = standard; the sidebar's grid size). */
  scale?: number
  /** Fixed strip width, px (the Executor page's grid size). */
  width?: number
}) {
  // Sizes for a non-standard scale (inline styles override the standard classes).
  const sz = (px: number) => (scale === 1 ? undefined : Math.round(px * scale))
  const run = engine.showState.executors[String(no)]
  const current = seq && run?.sequenceId === seq.id && run.cueId ? seq.cues[run.cueId] : null
  const inst = run?.instanceId ? engine.showState.active[run.instanceId] : null
  const live = !!inst && inst.stopAt == null
  const paused = live && inst!.pausedAt != null
  const next = seq ? cueAfter(seq, current ? current.id : null) : null
  const level = engine.showState.execLevels[String(no)] ?? 1
  const progress = useProgress(engine, inst && live ? inst : null, current)
  const act = (p: Promise<unknown>) => p.catch((err: Error) => onError(err.message))
  const count = seq ? Object.keys(seq.cues).length : 0

  return (
    <div
      className={`relative flex flex-col gap-2 rounded-2xl border p-2.5 transition ${fill ? 'w-full min-w-0' : 'w-[136px] shrink-0'} ${
        storeArmed ? 'animate-[pulse_1.2s_ease-in-out_infinite] cursor-copy border-panic/70 bg-panic/[0.06]' : selected ? 'border-accent bg-accent/[0.07]' : 'border-line bg-panel/80'
      }`}
      style={width && !fill ? { width } : undefined}
      onClickCapture={(e) => {
        // Store mode: any tap on the strip picks it as the target.
        if (!storeArmed) return
        e.preventDefault()
        e.stopPropagation()
        onPress()
      }}
      data-executor={no}
      data-exec-state={!run ? 'off' : paused ? 'paused' : live ? 'running' : 'on'}
    >
      <button type="button" onClick={onPress} className="text-left" title="選取：在下方顯示序列表" data-exec-select={no}>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-bold text-white/45">EXEC {no}</span>
          <span className={`ml-auto h-2 w-2 rounded-full ${paused ? 'bg-standby' : live ? 'bg-go shadow-[0_0_8px_#30d158]' : run ? 'bg-white/40' : 'bg-white/10'}`} />
        </div>
        <div className="truncate text-sm font-semibold" title={seq?.name}>
          {seq ? seq.name : <span className="text-white/25">空</span>}
        </div>
      </button>

      <div className="min-h-[58px] rounded-lg bg-black/40 px-2 py-1.5 text-[11px]" style={{ minHeight: sz(58), fontSize: sz(11) }} data-exec-current={current?.id ?? ''}>
        {current ? (
          <>
            <div className="flex items-baseline gap-1 truncate">
              <span className={`font-mono font-bold ${paused ? 'text-standby' : 'text-go'}`}>{formatCueNumber(current.number)}</span>
              <span className="truncate text-white/85">{current.name || sourceLabel(current.source, cues)}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full ${paused ? 'bg-standby' : 'bg-go'}`} style={{ width: `${progress * 100}%` }} data-exec-progress />
            </div>
          </>
        ) : (
          <div className="text-white/30">{seq ? `${count} 個 Cue` : '—'}</div>
        )}
        {next && (
          <div className="mt-1 truncate text-white/40" data-exec-next={next.id}>
            ▸ {formatCueNumber(next.number)} {next.name || sourceLabel(next.source, cues)}
            {next.trig !== 'go' && <span className="ml-1 rounded bg-white/10 px-1 text-[9px]">{TRIG_LABELS[next.trig]}</span>}
          </div>
        )}
      </div>

      <div className="flex items-stretch gap-2">
        <div className="flex flex-col items-center">
          <ExecFader value={level} onChange={(v) => engine.setExecLevel(no, v)} disabled={storeArmed} height={sz(112) ?? 112} label={`Executor ${no} 推桿`} no={no} />
          <span className="mt-1 font-mono text-[10px] text-white/50 tabular">{Math.round(level * 100)}</span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <button
            type="button"
            onClick={() => act(exec.go(no))}
            disabled={!seq || !count}
            className="h-16 rounded-xl bg-gradient-to-b from-[#3ee26a] to-[#1f9e44] text-xl font-black tracking-wider text-black shadow-[inset_0_-4px_0_rgba(0,0,0,0.3),0_4px_14px_rgba(48,209,88,0.35)] transition active:translate-y-0.5 active:shadow-[inset_0_-1px_0_rgba(0,0,0,0.3)] disabled:opacity-30 disabled:shadow-none"
            style={{ height: sz(64), fontSize: sz(20) }}
            aria-label={`Executor ${no} GO`}
            data-exec-go={no}
          >
            GO
          </button>
          <button
            type="button"
            onClick={() => act(exec.pause(no))}
            disabled={!live}
            className={`h-10 rounded-xl text-xs font-black tracking-wider shadow-[inset_0_-3px_0_rgba(0,0,0,0.3)] transition active:translate-y-0.5 disabled:opacity-30 ${
              paused ? 'animate-pulse bg-standby text-black' : 'bg-gradient-to-b from-[#ffcf33] to-[#c99a00] text-black'
            }`}
            style={{ height: sz(40), fontSize: sz(12) }}
            aria-label={`Executor ${no} PAUSE`}
            aria-pressed={paused}
            data-exec-pause={no}
          >
            {paused ? '▶ 繼續' : '❚❚ PAUSE'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" onClick={() => act(exec.back(no))} disabled={!seq || !count} style={{ height: sz(32), fontSize: sz(10) }} className="h-8 rounded-lg bg-white/[0.08] text-[10px] font-bold text-white/75 hover:bg-white/15 disabled:opacity-30" title="GO−：回到上一個 Cue" data-exec-back={no}>
          GO−
        </button>
        <button type="button" onClick={() => act(exec.off(no))} disabled={!run} style={{ height: sz(32), fontSize: sz(10) }} className="h-8 rounded-lg bg-white/[0.08] text-[10px] font-bold text-white/75 hover:bg-panic/25 hover:text-panic disabled:opacity-30" title="OFF：淡出並回到開頭" data-exec-off={no}>
          OFF
        </button>
      </div>
    </div>
  )
}

/**
 * An executor fader made for fingers: grab it anywhere on the track and it moves with the finger
 * from where it was (no jump to the touch point, so a resting finger never changes the level); the
 * page doesn't scroll or zoom under it. Arrow keys ±1 %, Page Up / Down ±10 %, Home / End.
 */
function ExecFader({ value, onChange, disabled, height, label, no }: { value: number; onChange: (v: number) => void; disabled: boolean; height: number; label: string; no: number }) {
  const grab = useRef<{ y: number; value: number; track: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const clamp01 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
  const end = () => {
    grab.current = null
    setDragging(false)
  }
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-disabled={disabled}
      className={`relative flex w-7 cursor-ns-resize touch-none justify-center outline-none select-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:w-11 ${disabled ? 'opacity-40' : ''}`}
      style={{ height }}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        grab.current = { y: e.clientY, value, track: e.currentTarget.getBoundingClientRect().height - 16 }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const g = grab.current
        if (!g) return
        onChange(clamp01(g.value + (g.y - e.clientY) / Math.max(1, g.track)))
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (disabled) return
        const step = { ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01, PageUp: 0.1, PageDown: -0.1 }[e.key]
        if (step != null) onChange(clamp01(value + step))
        else if (e.key === 'Home') onChange(0)
        else if (e.key === 'End') onChange(1)
        else return
        e.preventDefault()
      }}
      data-exec-fader={no}
      data-value={value}
    >
      <span className="absolute inset-y-2 w-1.5 rounded-full bg-white/15" />
      <span className="absolute bottom-2 w-1.5 rounded-full bg-white/70" style={{ height: `calc((100% - 16px) * ${value})` }} />
      <span
        className={`absolute h-4 w-6 -translate-y-1/2 rounded-md border border-black/30 shadow-[0_2px_6px_rgba(0,0,0,0.5)] transition-colors pointer-coarse:h-5 pointer-coarse:w-9 ${dragging ? 'bg-accent' : 'bg-white'}`}
        style={{ top: `calc(8px + (100% - 16px) * ${1 - value})` }}
      />
    </div>
  )
}

/** 0–1 through the running cue (its sound's length; fade-in for loops / unknown lengths). */
function useProgress(engine: Engine, inst: { firedAt: number; pausedAt: number | null } | null, cue: SeqCue | null) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!inst || inst.pausedAt != null) return
    let frame = 0
    const step = () => {
      setNow(engine.serverNow())
      frame = window.setTimeout(step, 100) as unknown as number
    }
    step()
    return () => clearTimeout(frame)
  }, [inst, engine])
  if (!inst || !cue) return 0
  const length = cue.loop || !cue.duration ? Math.max(cue.fadeIn, 0.001) : cue.duration
  const t = ((inst.pausedAt ?? now) - inst.firedAt) / 1000 - cue.delay
  return Math.max(0, Math.min(1, t / length))
}

/* ---------- store dialog ---------- */

function StoreDialog({
  no,
  seq,
  running,
  sheetCue,
  values,
  touched,
  onClose,
  onDone,
  onError,
  projectId,
  surfaceId,
  act,
}: {
  no: number
  seq: Sequence | null
  running: string | null
  sheetCue: string | null
  values: CueValues
  touched: Set<Field>
  onClose: () => void
  onDone: (text: string) => void
  onError: (t: string) => void
  projectId: string
  surfaceId: string
  act: (p: Promise<unknown>) => Promise<unknown>
}) {
  const [name, setName] = useState(`Seq ${no}`)
  const box = useRef<HTMLDivElement>(null)
  // Merge target: the cue selected in the sheet, else the one running.
  const target = seq ? (sheetCue && seq.cues[sheetCue]) || (running && seq.cues[running]) || null : null
  const merged = Object.fromEntries([...touched].map((f) => [f, values[f]])) as Partial<CueValues>
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-store-option]')?.focus()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const named = { ...values, name: values.name || sourceLabel(values.source, []) }

  return (
    <motion.div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        ref={box}
        initial={{ scale: 0.96, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 10 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-2xl border border-line bg-panel/95 p-5 shadow-2xl"
        role="dialog"
        aria-label={`Store 到 Executor ${no}`}
        data-store-dialog={no}
      >
        <div>
          <div className="text-[11px] font-bold tracking-[0.2em] text-panic">STORE</div>
          <h2 className="text-lg font-semibold">
            Executor {no}
            {seq ? <span className="text-white/50">「{seq.name}」</span> : <span className="text-white/40">（空）</span>}
          </h2>
          <p className="text-xs text-white/45">寫入：{sourceLabel(values.source, [])}{values.name ? ` · ${values.name}` : ''} · 音量 {Math.round(values.volume)}% · Fade {values.fadeIn}s / Out {values.fadeOut}s · Delay {values.delay}s · {TRIG_LABELS[values.trig]}</p>
        </div>
        {!seq ? (
          <>
            <label className="block text-xs text-white/55">
              新序列名稱
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-accent" data-store-seq-name />
            </label>
            <StoreOption
              title="建立序列並存成 Cue 1"
              detail={`在 Executor ${no} 建立「${name || `Seq ${no}`}」`}
              onClick={() => act(storeNewSequence(projectId, surfaceId, no, named, name.trim() || `Seq ${no}`).then(() => onDone(`已建立「${name || `Seq ${no}`}」並存成 Cue 1`)))}
              data="new"
            />
          </>
        ) : (
          <>
            <StoreOption
              title="Append（附加）"
              detail={`存成新的 Cue ${nextCueNumber(seq)}，加在序列最後`}
              onClick={() => act(appendCue(projectId, surfaceId, seq, named).then((r) => onDone(`已附加為「${seq.name}」Cue ${r.number}`)))}
              data="append"
            />
            <StoreOption
              title="Merge（合併）"
              detail={
                !target
                  ? '沒有可合併的 Cue：請先在序列表選一個 Cue，或讓 Executor 執行中'
                  : !touched.size
                    ? 'Programmer 沒有設定任何值'
                    : `把 ${touched.size} 項設定覆蓋到 Cue ${formatCueNumber(target.number)}「${target.name || sourceLabel(target.source, [])}」${sheetCue && target.id === sheetCue ? '（序列表選取）' : '（執行中）'}`
              }
              disabled={!target || !touched.size}
              onClick={() =>
                target && touched.size
                  ? act(mergeCue(projectId, surfaceId, seq, target, merged).then(() => onDone(`已合併到「${seq.name}」Cue ${formatCueNumber(target.number)}`)))
                  : onError('沒有可合併的內容')
              }
              data="merge"
            />
          </>
        )}
        <button type="button" onClick={onClose} className="h-10 w-full rounded-lg bg-white/[0.07] text-sm text-white/70 hover:bg-white/15" data-store-cancel>
          取消
        </button>
      </motion.div>
    </motion.div>
  )
}

function StoreOption({ title, detail, onClick, disabled, data }: { title: string; detail: string; onClick: () => void; disabled?: boolean; data: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-left outline-none hover:border-accent hover:bg-accent/15 focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
      data-store-option={data}
    >
      <div className="font-semibold">{title}</div>
      <div className="text-xs text-white/50">{detail}</div>
    </button>
  )
}

/* ---------- sequence sheet ---------- */

function SequenceSheet({
  no,
  seq,
  surface,
  projectId,
  engine,
  exec,
  cues,
  selectedCue,
  onSelectCue,
  onMessage,
}: {
  no: number
  seq: Sequence | null
  surface: Surface
  projectId: string
  engine: Engine
  exec: Exec
  cues: Cue[]
  selectedCue: string | null
  onSelectCue: (id: string | null) => void
  onMessage: (text: string, ok?: boolean) => void
}) {
  const run = engine.showState.executors[String(no)]
  const currentId = seq && run?.sequenceId === seq.id ? run.cueId : null
  const nextId = seq ? cueAfter(seq, currentId)?.id : null
  const act = (p: Promise<unknown>) => p.catch((err: Error) => onMessage(err.message, false))
  const all = Object.values(surface.sequences).sort((a, b) => a.name.localeCompare(b.name))
  const edit = (c: SeqCue, change: Partial<Omit<SeqCue, 'id'>>) => seq && act(updateSeqCue(projectId, surface.id, seq, c, change))
  const list = orderedCues(seq)

  return (
    <section className="min-h-[220px] flex-1 overflow-hidden rounded-2xl border border-line bg-panel/80" aria-label={`Executor ${no} 序列表`} data-sequence-sheet={no}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-xs font-bold text-white/45">EXEC {no}</span>
        {seq ? (
          <input
            key={seq.id}
            defaultValue={seq.name}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== seq.name && act(renameSequence(projectId, surface.id, seq, e.target.value.trim()))}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-semibold outline-none hover:border-white/10 focus:border-accent sm:max-w-60"
            aria-label="序列名稱"
            data-seq-name
          />
        ) : (
          <span className="text-sm text-white/40">沒有載入序列</span>
        )}
        <select
          value={seq?.id ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__new') act(createSequence(projectId, surface.id, `Seq ${no}`, no))
            else act(assignExecutor(projectId, surface.id, no, v || null))
          }}
          className="h-8 appearance-none rounded-md bg-white/[0.07] px-2 text-xs text-white/75"
          aria-label="載入序列"
          data-seq-assign
        >
          <option value="">{seq ? '— 卸載序列 —' : '— 選擇序列 —'}</option>
          {all.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="__new">＋ 新序列</option>
        </select>
        {seq && (
          <button
            type="button"
            onClick={() => confirm(`刪除序列「${seq.name}」？（所有 Cue 會一併刪除）`) && act(deleteSequence(projectId, surface.id, seq, surface.executors))}
            className="h-8 rounded-md px-2 text-xs text-white/40 hover:bg-panic/15 hover:text-panic"
            data-seq-delete
          >
            刪除序列
          </button>
        )}
      </header>
      {!seq ? (
        <p className="p-6 text-center text-sm text-white/35">在 Programmer 設定好後按 STORE，再點 Executor {no}，就會建立序列；或從上方選一個已有的序列載入。</p>
      ) : list.length === 0 ? (
        <p className="p-6 text-center text-sm text-white/35">「{seq.name}」還沒有 Cue：用 STORE › Append 加入。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs" data-sheet-table>
            <thead className="text-[10px] tracking-wider text-white/40 uppercase">
              <tr className="border-b border-line">
                <th className="w-8 px-2 py-2" />
                <th className="w-16 px-1 py-2">No.</th>
                <th className="px-1 py-2">名稱 / 來源</th>
                <th className="w-20 px-1 py-2">音量</th>
                <th className="w-16 px-1 py-2">Pan</th>
                <th className="w-16 px-1 py-2">Fade</th>
                <th className="w-16 px-1 py-2">Out</th>
                <th className="w-16 px-1 py-2">Delay</th>
                <th className="w-28 px-1 py-2">Trig</th>
                <th className="w-12 px-1 py-2">Loop</th>
                <th className="w-20 px-1 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const isCurrent = c.id === currentId
                const isNext = c.id === nextId
                const isSel = c.id === selectedCue
                const cell = 'h-7 w-full rounded border border-transparent bg-transparent px-1 text-right font-mono outline-none hover:border-white/10 focus:border-accent focus:bg-black/40'
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelectCue(isSel ? null : c.id)}
                    className={`border-b border-line/60 ${isCurrent ? 'bg-go/[0.12]' : isSel ? 'bg-accent/[0.12]' : 'hover:bg-white/[0.03]'}`}
                    data-sheet-cue={c.id}
                    data-sheet-state={isCurrent ? 'current' : isNext ? 'next' : undefined}
                    aria-selected={isSel}
                  >
                    <td className="px-2 text-center font-bold">{isCurrent ? <span className="text-go">▶</span> : isNext ? <span className="text-white/40">▸</span> : ''}</td>
                    <td className="px-1" onClick={(e) => e.stopPropagation()}>
                      <SecondsInput value={c.number} onChange={(v) => edit(c, { number: v })} className={cell} data="number" max={9999} />
                    </td>
                    <td className="px-1 py-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        defaultValue={c.name}
                        key={c.name}
                        onBlur={(e) => e.target.value !== c.name && edit(c, { name: e.target.value })}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        placeholder={sourceLabel(c.source, cues)}
                        className="h-7 w-full rounded border border-transparent bg-transparent px-1 font-semibold outline-none hover:border-white/10 focus:border-accent focus:bg-black/40"
                        data-sheet-name
                      />
                      <div className="truncate px-1 text-[10px] text-white/35">{sourceLabel(c.source, cues)}{c.duration ? ` · ${Math.round(c.duration * 10) / 10}s` : ''}</div>
                    </td>
                    <td className="px-1" onClick={(e) => e.stopPropagation()}>
                      <SecondsInput value={c.volume} onChange={(v) => edit(c, { volume: Math.min(100, v) })} className={cell} data="volume" max={100} />
                    </td>
                    <td className="px-1 text-center font-mono text-white/70" onClick={(e) => e.stopPropagation()} onDoubleClick={() => edit(c, { pan: 0 })} title="雙擊回到中間">
                      <input type="range" min={-1} max={1} step={0.05} value={c.pan} onChange={(e) => edit(c, { pan: Number(e.target.value) })} className="w-14 accent-accent" aria-label="Pan" data-sheet-pan />
                      <div className="text-[9px]">{panLabel(c.pan)}</div>
                    </td>
                    {(['fadeIn', 'fadeOut', 'delay'] as const).map((f) => (
                      <td key={f} className="px-1" onClick={(e) => e.stopPropagation()}>
                        <SecondsInput value={c[f]} onChange={(v) => edit(c, { [f]: v })} className={cell} data={f} />
                      </td>
                    ))}
                    <td className="px-1" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <select value={c.trig} onChange={(e) => edit(c, { trig: e.target.value as SeqTrig })} className="h-7 min-w-0 flex-1 appearance-none rounded border border-white/10 bg-black/30 px-1" aria-label="Trig" data-sheet-trig>
                          {(['go', 'follow', 'time'] as const).map((t) => (
                            <option key={t} value={t}>
                              {TRIG_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        {c.trig === 'time' && <SecondsInput value={c.trigTime} onChange={(v) => edit(c, { trigTime: v })} className="h-7 w-11 rounded border border-white/10 bg-black/30 px-1 text-right font-mono" data="trigTime" />}
                      </div>
                    </td>
                    <td className="px-1 text-center" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={c.loop} onChange={(e) => edit(c, { loop: e.target.checked })} className="accent-go" aria-label="Loop" />
                    </td>
                    <td className="px-1 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => act(exec.gotoCue(no, c))} className="h-7 rounded px-2 text-[11px] font-bold text-go hover:bg-go/15" title="GOTO：直接觸發這個 Cue" data-sheet-goto={c.id}>
                        GOTO
                      </button>
                      <button type="button" onClick={() => confirm(`刪除 Cue ${formatCueNumber(c.number)}？`) && act(deleteSeqCue(projectId, surface.id, seq, c))} className="h-7 rounded px-1.5 text-white/30 hover:bg-panic/15 hover:text-panic" aria-label="刪除 Cue" data-sheet-delete={c.id}>
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
