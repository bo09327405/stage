import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SpatialAuditioner } from '../../studio/spatial'
import {
  TRAJ_LIMIT,
  TRAJ_LOOP_MODES,
  TRAJ_PRESET_SHAPES,
  generatePreset,
  normalizeTrajectory,
  type TrajPathType,
  type TrajectoryConfig,
  type TrajPreset,
  type TrajVec3,
} from '../../types/trajectory'
import { Section, Slider } from './Inspector'
import { TrajectoryViewport, type TrajDot, type TrajTool, type TrajView } from './TrajectoryViewport'

const VIEWS: { id: TrajView; label: string }[] = [
  { id: 'top', label: '頂視 Top (XZ)' },
  { id: 'side', label: '側視 Side (YZ)' },
  { id: 'persp', label: '3D 透視' },
]

const PATH_TYPES: { id: TrajPathType; label: string }[] = [
  { id: 'static', label: '定點' },
  { id: 'freehand', label: '手繪' },
  { id: 'preset', label: '預設路徑' },
]

function Seg<T extends string>({ items, value, onChange, small }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className="flex gap-1" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={`min-h-8 flex-1 rounded-md px-1.5 ${small ? 'text-[10px]' : 'text-[11px]'} font-semibold ${value === it.id ? 'bg-white/15 text-white' : 'bg-white/[0.05] text-white/50 hover:text-white/80'}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

function Btn({ children, onClick, on, disabled, title }: { children: ReactNode; onClick: () => void; on?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={on}
      className={`min-h-8 rounded-md px-2.5 text-[11px] font-semibold disabled:opacity-30 ${on ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/14'}`}
    >
      {children}
    </button>
  )
}

const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} m`

export interface TrajectoryEditorProps {
  /** What is being placed (a track name, a cue title), for messages. */
  title: string
  /** Colour of its dot in the viewport. */
  color: string
  /** Changes when a different thing is opened (track / cue id): drops the selection and re-reads `value`. */
  resetKey: string
  value: TrajectoryConfig
  /** The config was changed; called once per finished gesture (a slider release, a drag end, a click). */
  onSave: (next: TrajectoryConfig, label: string) => void
  /** Studio tracks can follow another track's path: the config that is really played for a draft. */
  resolve?: (draft: TrajectoryConfig) => TrajectoryConfig
  /** When set, the path is another track's: it can be heard and placed in time here, but not edited. */
  followedName?: string
  /** Other sounds that move along the same path (tracks following this one). */
  extraDots?: TrajDot[]
  audition: {
    context: () => AudioContext
    output: () => AudioNode
    /** The sound to loop for the audition (null = a click train). */
    buffer: () => Promise<AudioBuffer | null>
    /** There is a real sound to offer next to the click train. */
    hasOwnSound: boolean
  }
  /** Seconds on the path clock from outside (the studio's transport), or null when nothing plays. */
  clock?: () => number | null
  /** Extra section at the end (the studio's multi-track group). */
  group?: (api: { draft: TrajectoryConfig; commit: (next: TrajectoryConfig, label: string) => void }) => ReactNode
}

/**
 * The 3D sound-trajectory editor: a viewport with the listener, the spline, its waypoints and the moving sound, and
 * the settings below it — path (point, hand-drawn, geometric), timing, acoustics (distance, air absorption, reverb)
 * and head tracking. 試聽 plays the sound (or a click train) through the real HRTF chain, so edits are heard as they
 * are made — use headphones. Used by the Studio's 空間 tab (a track) and the cue editor (a file cue).
 */
export function TrajectoryEditor({ title, color, resetKey, value, onSave, resolve, followedName, extraDots, audition, clock, group }: TrajectoryEditorProps) {
  const [view, setView] = useState<TrajView>('top')
  const [tool, setTool] = useState<TrajTool>('edit')
  const [selected, setSelected] = useState<number | null>(null)
  const [drawHeight, setDrawHeight] = useState(0)
  const [scrub, setScrub] = useState(0)
  const [big, setBig] = useState(false)
  const [auditioning, setAuditioning] = useState(false)
  const [useOwnSound, setUseOwnSound] = useState(true)
  const [note, setNote] = useState('')

  /* The edited config lives here while a gesture is going (and is heard at once); it is saved when the gesture ends. */
  const [draft, setDraft] = useState<TrajectoryConfig>(value)
  const draftRef = useRef(draft)
  const [gesture, setGesture] = useState(false)
  useEffect(() => {
    draftRef.current = draft
  })
  const storedKey = `${resetKey}:${JSON.stringify(value)}`
  const [syncedKey, setSyncedKey] = useState(storedKey)
  if (syncedKey !== storedKey && !gesture) {
    setSyncedKey(storedKey)
    setDraft(value)
  }
  const [lastKey, setLastKey] = useState(resetKey)
  if (lastKey !== resetKey) {
    setLastKey(resetKey)
    setSelected(null)
    setScrub(0)
    setAuditioning(false)
  }

  const followed = !!followedName
  const played = (cfg: TrajectoryConfig) => (resolve ? resolve(cfg) : cfg)
  const effective = useMemo(() => (resolve ? resolve(draft) : draft), [resolve, draft])
  const dots = useMemo<TrajDot[]>(() => [{ color, cfg: effective }, ...(extraDots ?? [])], [color, effective, extraDots])

  /* ---------- audition ---------- */
  const aud = useRef<SpatialAuditioner | null>(null)
  const stopAudition = () => {
    aud.current?.stop()
    setAuditioning(false)
  }
  // Opening something else (or leaving) ends the audition.
  useEffect(() => () => aud.current?.stop(), [resetKey])
  const effectiveRef = useRef(effective)
  useEffect(() => {
    effectiveRef.current = effective
  })

  const toggleAudition = async () => {
    if (auditioning) return stopAudition()
    try {
      const ctx = audition.context()
      await ctx.resume()
      aud.current ??= new SpatialAuditioner(ctx, audition.output())
      const buffer = useOwnSound && audition.hasOwnSound ? await audition.buffer() : null
      aud.current.start(effectiveRef.current, buffer)
      setAuditioning(true)
      setNote(useOwnSound && !audition.hasOwnSound ? '還沒有可試聽的聲音，改用測試音' : '')
    } catch (err) {
      setNote(`無法試聽：${(err as Error).message}`)
    }
  }
  const getTime = () => aud.current?.pathTime() ?? clock?.() ?? null

  /* ---------- editing ---------- */
  const preview = (next: TrajectoryConfig) => {
    setGesture(true)
    draftRef.current = next
    setDraft(next)
    aud.current?.update(played(next))
  }
  const commit = (next: TrajectoryConfig, label: string) => {
    setGesture(false)
    const clean = normalizeTrajectory(next)
    draftRef.current = clean
    setDraft(clean)
    aud.current?.update(played(clean))
    onSave(clean, label)
  }
  const patch = (p: Partial<TrajectoryConfig>) => ({ ...draftRef.current, ...p })

  const setWaypoints = (waypoints: TrajVec3[], final: boolean, kind: 'move' | 'draw') => {
    if (followed) return
    const cur = draftRef.current
    const next = normalizeTrajectory({
      ...cur,
      pathType: kind === 'draw' ? 'freehand' : cur.pathType === 'preset' ? 'freehand' : cur.pathType,
      waypoints,
      closed: kind === 'draw' ? false : cur.closed,
    })
    if (final) {
      if (kind === 'draw') setSelected(null)
      commit(next, kind === 'draw' ? '手繪軌跡' : '調整節點')
    } else preview(next)
  }

  const choosePathType = (pathType: TrajPathType) => {
    const cur = draftRef.current
    if (pathType === cur.pathType) return
    if (pathType === 'preset') {
      const g = generatePreset(cur.preset)
      return commit({ ...cur, pathType, waypoints: g.waypoints, closed: g.closed, playback: { ...cur.playback, loopMode: g.loopMode } }, '預設路徑')
    }
    if (pathType === 'freehand' && cur.waypoints.length < 2) {
      const a = cur.waypoints[0]
      return commit({ ...cur, pathType, waypoints: [a, { ...a, x: Math.min(TRAJ_LIMIT, a.x + 3) }], closed: false }, '手繪路徑')
    }
    commit({ ...cur, pathType, closed: pathType === 'static' ? false : cur.closed, waypoints: pathType === 'static' ? [cur.waypoints[0]] : cur.waypoints }, pathType === 'static' ? '定點' : '手繪路徑')
    setSelected(null)
  }

  const applyPreset = (preset: TrajPreset, label: string, shapeChanged = false) => {
    const cur = draftRef.current
    const g = generatePreset(preset)
    return {
      next: { ...cur, pathType: 'preset' as const, preset, waypoints: g.waypoints, closed: g.closed, playback: shapeChanged ? { ...cur.playback, loopMode: g.loopMode } : cur.playback },
      label,
    }
  }
  const presetSlide = (key: 'radius' | 'height' | 'turns') => ({
    onChange: (v: number) => preview(applyPreset({ ...draftRef.current.preset, [key]: v }, '').next),
    onCommit: (v: number) => {
      const r = applyPreset({ ...draftRef.current.preset, [key]: v }, '預設路徑參數')
      commit(r.next, r.label)
    },
  })

  const addWaypoint = () => {
    const cur = draftRef.current
    if (cur.pathType === 'static' || followed) return
    const i = selected ?? cur.waypoints.length - 1
    const a = cur.waypoints[i]
    const b = cur.waypoints[i + 1]
    const p: TrajVec3 = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } : { x: a.x + 1, y: a.y, z: a.z }
    const waypoints = [...cur.waypoints.slice(0, i + 1), p, ...cur.waypoints.slice(i + 1)]
    commit({ ...cur, pathType: 'freehand', waypoints }, '新增節點')
    setSelected(i + 1)
  }
  const removeWaypoint = () => {
    const cur = draftRef.current
    if (selected === null || cur.pathType === 'static' || cur.waypoints.length <= 2 || followed) return
    commit({ ...cur, pathType: 'freehand', waypoints: cur.waypoints.filter((_, i) => i !== selected) }, '刪除節點')
    setSelected(null)
  }
  const moveSelected = (axis: keyof TrajVec3) => ({
    onChange: (v: number) => {
      const cur = draftRef.current
      const i = selected ?? 0
      preview(normalizeTrajectory({ ...cur, pathType: cur.pathType === 'preset' ? 'freehand' : cur.pathType, waypoints: cur.waypoints.map((w, k) => (k === i ? { ...w, [axis]: v } : w)) }))
    },
    onCommit: () => commit(draftRef.current, '調整節點'),
  })

  const pb = draft.playback
  const ac = draft.acoustics
  const sel = selected !== null ? draft.waypoints[selected] : draft.pathType === 'static' ? draft.waypoints[0] : null

  return (
    <div data-trajectory-panel>
      <Section
        title={`3D 空間軌跡 · ${title}`}
        right={
          <button
            type="button"
            onClick={() => commit({ ...draftRef.current, enabled: !draft.enabled }, draft.enabled ? '關閉雙耳空間定位' : '啟用雙耳空間定位')}
            aria-pressed={draft.enabled}
            className={`min-h-8 rounded-md px-3 text-xs font-semibold ${draft.enabled ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/65 hover:bg-white/14'}`}
            data-traj-enable
          >
            {draft.enabled ? '雙耳 HRTF 開' : '未啟用'}
          </button>
        }
      >
        <p className="text-[11px] leading-relaxed text-white/45">請戴耳機。啟用後使用 HRTF 雙耳定位，取代左右聲相；Studio 匯出與觀眾端播放都會套用。</p>
        {followed && (
          <p className="rounded-md bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-white/60">
            跟隨「{followedName}」的路徑與速度，只有相位與聲學參數是自己的。要改路徑請到那個音軌編輯。
          </p>
        )}
      </Section>

      {big && <div className="fixed inset-0 z-[85] bg-black/70" onClick={() => setBig(false)} aria-hidden />}
      <section
        className={big ? 'fixed inset-3 z-[90] flex flex-col gap-2 rounded-xl border border-line bg-[#111113] p-3 shadow-2xl' : 'space-y-2 border-b border-line px-4 py-3'}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && (e.target as HTMLElement).tagName !== 'INPUT') removeWaypoint()
        }}
        data-traj-stage
      >
        <Seg items={VIEWS} value={view} onChange={setView} small />
        <div className="flex flex-wrap items-center gap-1.5">
          <Btn on={tool === 'edit'} onClick={() => setTool('edit')} title="拖曳節點調整位置；3D 視角按住 Shift 拖曳可調高度">
            ✥ 編輯
          </Btn>
          <Btn on={tool === 'draw'} onClick={() => setTool('draw')} disabled={followed} title="按住滑鼠或手指在畫布上拖曳，錄製一條自由軌跡">
            ✎ 手繪
          </Btn>
          <Btn onClick={toggleAudition} on={auditioning} title="用 HRTF 試聽這條軌跡">
            {auditioning ? '■ 停止' : '▶ 試聽'}
          </Btn>
          <span className="flex-1" />
          <Btn onClick={() => setBig(!big)} title={big ? '縮小' : '放大視口'}>
            {big ? '✕ 縮小' : '⤢ 放大'}
          </Btn>
        </div>
        <div className={big ? 'min-h-0 flex-1 overflow-hidden rounded-lg' : 'relative aspect-square w-full overflow-hidden rounded-lg'}>
          <TrajectoryViewport
            config={effective}
            view={view}
            tool={followed ? 'edit' : tool}
            selected={followed ? null : selected}
            drawHeight={drawHeight}
            dots={dots}
            getTime={getTime}
            scrub={scrub}
            onSelect={setSelected}
            onWaypoints={setWaypoints}
          />
          <span className="pointer-events-none absolute top-1.5 left-2 font-mono text-[10px] text-white/40">
            {{ top: '頂視：上＝前方 (−Z)', side: '側視：右＝前方 (−Z)', persp: '3D：拖曳旋轉、滾輪縮放' }[view]}
          </span>
        </div>
        {note && <p className="text-[11px] text-amber-300/80">{note}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          <Btn onClick={addWaypoint} disabled={draft.pathType === 'static' || followed} title="在選取的節點後面新增一個節點">
            ＋ 節點
          </Btn>
          <Btn onClick={removeWaypoint} disabled={selected === null || draft.waypoints.length <= 2 || draft.pathType === 'static' || followed}>
            － 刪除節點
          </Btn>
          <Btn
            onClick={() => {
              const a = draftRef.current.waypoints[0]
              commit({ ...draftRef.current, pathType: 'static', waypoints: [a], closed: false }, '清除軌跡')
              setSelected(null)
            }}
            disabled={draft.pathType === 'static' || followed}
          >
            清除軌跡
          </Btn>
        </div>
        {tool === 'draw' && <Slider label="手繪高度 Y" value={drawHeight} min={-10} max={10} step={0.1} display={fmt(drawHeight)} reset={0} onChange={setDrawHeight} />}
        <Seg
          items={[
            { id: 'own', label: '試聽音源：實際音訊' },
            { id: 'click', label: '測試音（點擊聲）' },
          ]}
          value={useOwnSound ? 'own' : 'click'}
          onChange={(v) => {
            setUseOwnSound(v === 'own')
            if (auditioning) stopAudition()
          }}
          small
        />
        <Slider label="預覽位置（不播放時）" value={scrub} min={0} max={1} step={0.005} display={`${Math.round(scrub * 100)}%`} onChange={setScrub} />
      </section>

      <Section title="路徑">
        <Seg items={PATH_TYPES} value={draft.pathType} onChange={choosePathType} />
        {draft.pathType === 'preset' && !followed && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-1">
              {TRAJ_PRESET_SHAPES.map((s) => (
                <Btn
                  key={s.id}
                  on={draft.preset.shape === s.id}
                  title={s.hint}
                  onClick={() => {
                    const r = applyPreset({ ...draftRef.current.preset, shape: s.id }, s.label, true)
                    commit(r.next, r.label)
                    setSelected(null)
                  }}
                >
                  {s.label}
                </Btn>
              ))}
            </div>
            <Slider label="半徑" value={draft.preset.radius} min={0.5} max={20} step={0.1} display={`${draft.preset.radius.toFixed(1)} m`} {...presetSlide('radius')} />
            <Slider label="高度" value={draft.preset.height} min={-8} max={8} step={0.1} display={fmt(draft.preset.height)} reset={0} {...presetSlide('height')} />
            {draft.preset.shape === 'spiral' && <Slider label="圈數" value={draft.preset.turns} min={0.5} max={8} step={0.5} display={`${draft.preset.turns} 圈`} {...presetSlide('turns')} />}
          </div>
        )}
        {sel && !followed && (
          <div className="space-y-2.5 rounded-lg bg-white/[0.04] p-2.5">
            <div className="text-[11px] text-white/50">{draft.pathType === 'static' ? '聲源位置' : `節點 ${(selected ?? 0) + 1} / ${draft.waypoints.length}`}（聆聽者在 0,0,0，面向 −Z）</div>
            <Slider label="左右 X（右為＋）" value={sel.x} min={-20} max={20} step={0.1} display={fmt(sel.x)} reset={0} {...moveSelected('x')} />
            <Slider label="高度 Y" value={sel.y} min={-10} max={10} step={0.1} display={fmt(sel.y)} reset={0} {...moveSelected('y')} />
            <Slider label="前後 Z（前方為－）" value={sel.z} min={-20} max={20} step={0.1} display={fmt(sel.z)} reset={-2} {...moveSelected('z')} />
          </div>
        )}
        {draft.pathType === 'freehand' && !followed && draft.waypoints.length >= 3 && (
          <Btn on={draft.closed} onClick={() => commit({ ...draftRef.current, closed: !draft.closed }, draft.closed ? '開放路徑' : '封閉路徑')} title="首尾相接成環">
            {draft.closed ? '◯ 封閉路徑' : '⌒ 開放路徑'}
          </Btn>
        )}
      </Section>

      <Section title="運動時間">
        {draft.pathType !== 'static' || followed ? (
          <>
            {!followed && (
              <>
                <Slider label="單趟時間" value={pb.durationSec} min={1} max={120} step={0.5} display={`${pb.durationSec.toFixed(1)} s`} reset={12} onChange={(v) => preview(patch({ playback: { ...pb, durationSec: v } }))} onCommit={() => commit(draftRef.current, '單趟時間')} />
                <Seg items={TRAJ_LOOP_MODES} value={pb.loopMode} onChange={(m) => commit(patch({ playback: { ...pb, loopMode: m } }), '循環模式')} />
              </>
            )}
            <Slider
              label="相位偏移 Phase"
              value={pb.phaseOffset}
              min={0}
              max={1}
              step={0.01}
              display={pb.phaseOffset.toFixed(2)}
              reset={0}
              onChange={(v) => preview(patch({ playback: { ...pb, phaseOffset: v } }))}
              onCommit={() => commit(draftRef.current, '路徑相位')}
            />
          </>
        ) : (
          <p className="text-[11px] text-white/40">定點聲源不移動。改成「手繪」或「預設路徑」才有運動時間。</p>
        )}
      </Section>

      <Section title="聲學 Acoustics">
        <Slider label="參考距離 refDistance" value={ac.refDistance} min={0.1} max={10} step={0.1} display={`${ac.refDistance.toFixed(1)} m`} reset={1} onChange={(v) => preview(patch({ acoustics: { ...ac, refDistance: v } }))} onCommit={() => commit(draftRef.current, '參考距離')} />
        <Slider label="最大距離 maxDistance" value={ac.maxDistance} min={2} max={100} step={1} display={`${Math.round(ac.maxDistance)} m`} reset={20} onChange={(v) => preview(patch({ acoustics: { ...ac, maxDistance: v } }))} onCommit={() => commit(draftRef.current, '最大距離')} />
        <Slider label="衰減曲線 rolloff" value={ac.rolloffFactor} min={0} max={4} step={0.05} display={ac.rolloffFactor.toFixed(2)} reset={1} onChange={(v) => preview(patch({ acoustics: { ...ac, rolloffFactor: v } }))} onCommit={() => commit(draftRef.current, '距離衰減')} />
        <Slider label="空氣吸收（遠處變悶）" value={ac.airAbsorption} min={0} max={1} step={0.01} display={`${Math.round(ac.airAbsorption * 100)}%`} reset={0.5} accent="#da77f2" onChange={(v) => preview(patch({ acoustics: { ...ac, airAbsorption: v } }))} onCommit={() => commit(draftRef.current, '空氣吸收')} />
        <Slider label="空間殘響 reverbSend" value={ac.reverbSend} min={0} max={1} step={0.01} display={`${Math.round(ac.reverbSend * 100)}%`} reset={0.25} accent="#bf5af2" onChange={(v) => preview(patch({ acoustics: { ...ac, reverbSend: v } }))} onCommit={() => commit(draftRef.current, '空間殘響')} />
      </Section>

      <Section title="觀眾端 · 頭部追蹤">
        <Btn
          on={draft.headTrack}
          onClick={() => commit({ ...draftRef.current, headTrack: !draft.headTrack }, draft.headTrack ? '關閉頭部追蹤' : '開啟頭部追蹤')}
          title="觀眾開啟陀螺儀或進入 XR 時，聲場跟著頭轉動"
        >
          {draft.headTrack ? '✓ 聲場跟隨觀眾轉頭' : '聲場固定朝向正前方'}
        </Btn>
        <p className="text-[10px] leading-relaxed text-white/35">只在觀眾端有陀螺儀（XR 場景）或頭戴裝置時有作用：轉頭時，聲音留在原本的方位。</p>
      </Section>

      {group && <Section title="多軌群組">{group({ draft, commit })}</Section>}
    </div>
  )
}
