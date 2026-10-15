import { executorNumbers } from '../../types/sequence'
import { useState } from 'react'
import type { Cue, Hit } from '../../types/cue'
import {
  MIDI_MESSAGE_LABELS,
  OSC_ARG_LABELS,
  PANEL_LABELS,
  PANEL_MODE_LABELS,
  WIDGET_COLORS,
  defaultAction,
  EXEC_COMMAND_LABELS,
  type ExecCommand,
  type ButtonDisplay,
  type IntercomMode,
  type MidiMessage,
  type OscArgType,
  type PanelMode,
  type PanelTarget,
  type ParamTarget,
  type ShowParam,
  type StudioParam,
  type SurfaceAction,
  type SurfaceWidget,
} from '../../types/surface'
import { defaultMatch } from '../../types/trigger'
import { ActionPicker } from '../ui/ActionPicker'
import { ImeInput, ImeTextarea } from '../ui/ImeText'
import { NotionUrlField } from '../notes/NotionUrlField'
import { isOnlyNotionUrl } from '../../services/notion'
import { Label, NumberField, Segmented, Toggle, fieldClass } from '../ui/controls'
import { TriggerMatchEditor } from '../ui/TriggerMatchEditor'
import { useStudio, useStudioList } from '../../services/studio'
import { SHOW_PARAMS, STUDIO_PARAMS } from '../../utils/liveParams'

interface WidgetPropertiesProps {
  widget: SurfaceWidget
  cues: Cue[]
  hits: Hit[]
  /** For binding knobs / faders to this project's DAW Studios. */
  projectId: string
  /** Surface-wide OSC target, shown as the placeholder for per-action overrides. */
  defaultOscTarget: string
  onChange: (widget: SurfaceWidget) => void
  onDelete: () => void
  onClose: () => void
}

/** faderOnly: knobs and faders (continuous controls); trueFaderOnly: faders only. */
const KIND_OPTIONS: { id: SurfaceAction['kind']; label: string; faderOnly?: boolean; buttonOnly?: boolean; trueFaderOnly?: boolean }[] = [
  { id: 'show', label: '🎬 標準演出動作', buttonOnly: true },
  { id: 'cue', label: '🎯 指定 Cue', buttonOnly: true },
  { id: 'master', label: '🔊 Master 音量', faderOnly: true },
  { id: 'param', label: '🎛 效果 / EQ / Pan / 音量', faderOnly: true },
  { id: 'xfade', label: '⏭ 走 Cue（手動 Crossfade）', faderOnly: true, trueFaderOnly: true },
  { id: 'hit', label: '💥 Hit 音效（音量 / 觸發）', faderOnly: true },
  { id: 'panel', label: '🪟 視窗開關', buttonOnly: true },
  { id: 'executor', label: '🎚 Executor（GO / PAUSE / 推桿）' },
  { id: 'midi', label: '🎹 MIDI' },
  { id: 'osc', label: '📡 OSC' },
]

const selectClass = `${fieldClass} appearance-none`

/** Properties drawer for one surface control: look, size, and signal mapping. */
export function WidgetProperties({ widget, cues, hits, projectId, defaultOscTarget, onChange, onDelete, onClose }: WidgetPropertiesProps) {
  const set = <K extends keyof SurfaceWidget>(key: K, value: SurfaceWidget[K]) => onChange({ ...widget, [key]: value })
  const setAction = (i: number, action: SurfaceAction) =>
    set('actions', widget.actions.map((a, j) => (j === i ? action : a)))
  const removeAction = (i: number) => set('actions', widget.actions.filter((_, j) => j !== i))
  const [adding, setAdding] = useState(false)
  const continuous = widget.type !== 'button'
  const kinds = KIND_OPTIONS.filter((k) => (continuous ? !k.buttonOnly && (widget.type === 'fader' || !k.trueFaderOnly) : !k.faderOnly))
  const monitor = widget.type === 'button' && widget.display === 'monitor'
  const note = widget.type === 'button' && widget.display === 'note'
  const stage = widget.type === 'button' && widget.display === 'stage'
  const intercom = widget.type === 'button' && widget.display === 'intercom'
  // Monitor / note / stage / intercom blocks show content instead of firing actions.
  const special = monitor || note || stage || intercom

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <div className="text-[11px] font-semibold tracking-widest text-white/40 uppercase">
            {widget.type === 'button'
              ? monitor
                ? 'Button · Cue Monitor'
                : note
                  ? 'Button · Note'
                  : stage
                    ? 'Button · Stage'
                    : intercom
                      ? 'Button · Intercom'
                      : 'Button'
              : widget.type === 'knob'
                ? 'Knob'
                : 'Fader'}{' '}
            · Properties
          </div>
          <div className="truncate text-lg font-semibold">{widget.label || '未命名'}</div>
        </div>
        <button
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
          aria-label="關閉"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {widget.type === 'button' && (
          <div data-field="按鈕類型">
            <Label>按鈕類型</Label>
            <Segmented<ButtonDisplay>
              columns={2}
              value={widget.display}
              onChange={(display) =>
                onChange({
                  ...widget,
                  display,
                  // A monitor needs room for two status rows; grow a small button when switching.
                  ...(display === 'intercom'
                    ? { w: Math.max(widget.w, 4), h: Math.max(widget.h, 4) }
                    : display !== 'action'
                      ? { w: Math.max(widget.w, 3), h: Math.max(widget.h, 3) }
                      : {}),
                })
              }
              options={[
                { id: 'action', label: '🔘 一般按鈕', description: '按下執行動作' },
                { id: 'monitor', label: '📺 Cue Monitor', description: '即時顯示 Active / Standby' },
                { id: 'note', label: '📝 Note', description: '劇本對白 / 備忘小視窗' },
                { id: 'stage', label: '🎭 Stage', description: '模擬觀眾畫面；點一下開關 Stage 視窗' },
                { id: 'intercom', label: '🎧 Intercom', description: '頻道 A / B / All Call、TALK、CALL、狀態燈' },
              ]}
            />
          </div>
        )}


        <label className="block">
          <Label>名稱</Label>
          <ImeInput className={fieldClass} value={widget.label} onValueChange={(v) => set('label', v)} data-field="元件名稱" />
        </label>

        <div>
          <Label>顏色</Label>
          <div className="flex flex-wrap gap-2">
            {WIDGET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                className={`h-10 w-10 rounded-xl transition ${widget.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-panel' : ''}`}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <NumberField label="寬" suffix="格" step={1} stepperStep={1} min={1} max={12} value={widget.w} onChange={(v) => set('w', Math.round(v))} />
          <NumberField label="高" suffix="格" step={1} stepperStep={1} min={1} max={12} value={widget.h} onChange={(v) => set('h', Math.round(v))} />
        </div>

        {note ? (
          <div className="space-y-3">
            <div data-field="內容來源">
              <Label>內容來源</Label>
              <Segmented<SurfaceWidget['noteSource']>
                columns={3}
                value={widget.noteSource}
                onChange={(v) => set('noteSource', v)}
                options={[
                  { id: 'custom', label: '✎ 手動筆記', description: '只屬於這個區塊' },
                  { id: 'script', label: '📝 劇本筆記區', description: '共用，跟隨 Standby' },
                  { id: 'notion', label: 'N Notion 預覽', description: '公開頁面即時預覽' },
                ]}
              />
            </div>
            {widget.noteSource === 'notion' && (
              <div>
                <Label>Notion 頁面網址</Label>
                <NotionUrlField value={widget.noteNotionUrl} onChange={(v) => set('noteNotionUrl', v)} />
              </div>
            )}
            {widget.noteSource === 'custom' && (
              <label className="block">
                <Label hint="寫 Q3 會變成可點選的 Cue 點">筆記內容</Label>
                <ImeTextarea
                  className={`${fieldClass} min-h-40 resize-y font-mono leading-relaxed`}
                  value={widget.noteText}
                  onValueChange={(v) => set('noteText', v)}
                  onPaste={(e) => {
                    // Pasting just a Notion link means "show that page": switch to Notion preview.
                    const pasted = e.clipboardData.getData('text')
                    if (!isOnlyNotionUrl(pasted)) return
                    e.preventDefault()
                    onChange({ ...widget, noteSource: 'notion', noteNotionUrl: pasted.trim() })
                  }}
                  placeholder={'例如：\nQ5 前：等演員走到舞台中央\n小明：「這是我最後的機會。」→ Q6'}
                  data-field="筆記內容"
                />
              </label>
            )}
            <label className="block">
              <Label>文字大小</Label>
              <span className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.6}
                  max={2.4}
                  step={0.1}
                  value={widget.noteFont}
                  onChange={(e) => set('noteFont', Number(e.target.value))}
                  className="flex-1 accent-[#bf5af2]"
                  aria-label="Note 文字大小"
                />
                <span className="w-10 font-mono text-xs text-white/60 tabular">{widget.noteFont.toFixed(1)}×</span>
              </span>
            </label>
          </div>
        ) : stage ? (
          <p className="rounded-xl bg-[#64d2ff]/10 px-3 py-2.5 text-xs leading-relaxed text-[#9ee3ff]" data-stage-help>
            這個按鈕會即時顯示觀眾畫面縮圖。演出時點一下，就能開啟 / 收合控制面板右側的「Stage 模擬觀眾畫面」視窗。
            <br />
            想用一般按鈕（或 MIDI / OSC 遠端按下）開關視窗，可改用「一般按鈕」並加入「🪟 視窗開關」動作。
          </p>
        ) : monitor ? (
          <div className="space-y-3">
            <Toggle
              label="顯示 Cue 清單"
              description="在 Active / Standby 下方列出所有 Cue，點選即可選取"
              checked={widget.monitorList}
              onChange={(v) => set('monitorList', v)}
            />
            {widget.monitorList && (
              <div>
                <Label>點選清單中的 Cue</Label>
                <Segmented<'standby' | 'go'>
                  columns={2}
                  value={widget.monitorTap}
                  onChange={(v) => set('monitorTap', v)}
                  options={[
                    { id: 'standby', label: '設為 Standby', description: '下一次 GO 執行它' },
                    { id: 'go', label: '直接 GO', description: '立即執行' },
                  ]}
                />
              </div>
            )}
          </div>
        ) : intercom ? (
          <div className="space-y-2" data-field="Intercom 顯示模式">
            <Label>Intercom 顯示模式</Label>
            <Segmented<IntercomMode>
              columns={1}
              value={widget.intercomMode}
              onChange={(intercomMode) =>
                onChange({ ...widget, intercomMode, ...(intercomMode === 'voice' ? {} : { w: Math.max(widget.w, 4), h: Math.max(widget.h, intercomMode === 'full' ? 7 : 4) }) })
              }
              options={[
                { id: 'voice', label: '🎙 僅語音控台 (Voice Only)', description: '頻道、TALK、CALL、燈號、音量與在線名單' },
                { id: 'chat', label: '💬 僅文字聊天視窗 (Chat Only)', description: '訊息紀錄與輸入框；送出時自動加入' },
                { id: 'full', label: '🎧 語音 + 聊天整合視窗 (Full Intercom with Chat)', description: '上方語音控台、下方聊天' },
              ]}
            />
            <p className="text-[11px] leading-relaxed text-white/45">
              使用此頁面的通訊頻道（與右上角 🎧 Intercom 相同）。聊天訊息依頻道傳送：Ch A / Ch B 只有同頻道與 All Call 看得到，All Call 的訊息所有人都看得到。鍵盤按住 T 即可發話（游標在輸入框時除外）。
            </p>
          </div>
        ) : continuous ? (
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="最小值" suffix="" step={0.1} stepperStep={1} min={-100000} value={widget.min} onChange={(v) => set('min', v)} />
            <NumberField label="最大值" suffix="" step={0.1} stepperStep={1} min={-100000} value={widget.max} onChange={(v) => set('max', v)} />
          </div>
        ) : (
          <Toggle
            label="Momentary（放開時送出）"
            description="放開按鈕時送 Note Off / CC 0 / OSC $value=0"
            checked={widget.momentary}
            onChange={(v) => set('momentary', v)}
          />
        )}

        {!special && (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold tracking-wider text-white/60">觸發動作 · Signal Mapping</h3>
              <span className="text-[11px] text-white/30">{widget.actions.length} 個</span>
            </div>

            {widget.actions.map((action, i) => (
              <div key={i} className="space-y-3 rounded-xl border border-line bg-black/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{KIND_OPTIONS.find((k) => k.id === action.kind)?.label}</span>
                  <button
                    type="button"
                    onClick={() => removeAction(i)}
                    className="min-h-9 rounded-lg px-2 text-xs text-white/35 hover:bg-panic/20 hover:text-panic"
                  >
                    移除
                  </button>
                </div>
                <ActionFields
                  action={action}
                  widget={widget}
                  cues={cues}
                  hits={hits}
                  projectId={projectId}
                  defaultOscTarget={defaultOscTarget}
                  onChange={(a) => setAction(i, a)}
                />
              </div>
            ))}

            {adding ? (
              <div className="grid grid-cols-2 gap-2">
                {kinds.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => {
                      set('actions', [...widget.actions, defaultAction(k.id, widget.type)])
                      setAdding(false)
                    }}
                    className="min-h-12 rounded-xl border border-line bg-black/30 text-sm text-white/80 hover:border-accent hover:text-white"
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="min-h-12 w-full rounded-xl border border-dashed border-white/20 text-sm text-white/60 hover:border-accent hover:text-white"
              >
                ＋ 新增動作
              </button>
            )}
          </section>
        )}

        {!special && (
          <section className="space-y-3">
            <Toggle
              label="接收外部訊號 · Input"
              description={
                continuous
                  ? `收到 MIDI CC 時轉動此${widget.type === 'knob' ? '旋鈕' : '推桿'}（OSC 以第一個數值參數 0–1 推動）`
                  : '收到指定 MIDI / OSC 時等同按下此按鈕'
              }
              checked={widget.input != null}
              onChange={(on) => set('input', on ? defaultMatch(continuous ? 'midi' : 'osc') : null)}
            />
            {widget.input && (
              <div className="rounded-xl border border-line bg-black/30 p-3">
                <TriggerMatchEditor match={widget.input} onChange={(m) => set('input', m)} />
              </div>
            )}
          </section>
        )}
      </div>

      <footer className="border-t border-line px-5 py-4">
        <button
          onClick={() => confirm(`刪除「${widget.label}」？`) && onDelete()}
          className="min-h-11 rounded-lg px-4 text-sm text-white/40 hover:bg-panic/20 hover:text-panic"
        >
          刪除元件
        </button>
      </footer>
    </div>
  )
}

function ActionFields({
  action,
  widget,
  cues,
  hits,
  projectId,
  defaultOscTarget,
  onChange,
}: {
  action: SurfaceAction
  widget: SurfaceWidget
  cues: Cue[]
  hits: Hit[]
  projectId: string
  defaultOscTarget: string
  onChange: (action: SurfaceAction) => void
}) {
  switch (action.kind) {
    case 'param':
      return <ParamFields target={action.target} projectId={projectId} onChange={(target) => onChange({ ...action, target })} />

    case 'executor':
      return (
        <div className="space-y-2">
          <select className={selectClass} value={action.exec} onChange={(e) => onChange({ ...action, exec: Number(e.target.value) })} data-field="Executor">
            {executorNumbers.map((n) => (
              <option key={n} value={n}>
                Executor {n}
              </option>
            ))}
          </select>
          {action.command === 'level' ? (
            <p className="text-[11px] text-white/45">推桿 / 旋鈕控制這個 Executor 的音量（0–100%）。</p>
          ) : (
            <Segmented<ExecCommand>
              columns={4}
              value={action.command}
              onChange={(command) => onChange({ ...action, command })}
              options={(['go', 'pause', 'back', 'off'] as const).map((c) => ({ id: c, label: EXEC_COMMAND_LABELS[c] }))}
            />
          )}
        </div>
      )

    case 'xfade':
      return (
        <p className="text-[11px] leading-relaxed text-white/45">
          推桿從底部往上推：開始時以 0 秒淡入啟動 Standby Cue，推桿位置即兩個 Cue 的交叉淡化比例（舊 Cue 淡出、新 Cue 淡入）；推到頂完成換場並停止舊 Cue。推到一半拉回底部會取消，回到原 Cue。完成後拉回底部即可準備下一個 Cue。
        </p>
      )

    case 'hit':
      return (
        <div className="space-y-2">
          <select className={selectClass} value={action.hitId} onChange={(e) => onChange({ ...action, hitId: e.target.value })} data-field="Hit 音效">
            <option value="">— 選擇 Hit 音效 —</option>
            {hits.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title}
              </option>
            ))}
          </select>
          <Segmented<'level' | 'trigger'>
            columns={2}
            value={action.mode}
            onChange={(mode) => onChange({ ...action, mode })}
            options={[
              { id: 'level', label: '動態音量', description: '控制此 Hit 正在播放與之後的音量' },
              { id: 'trigger', label: '觸發開關', description: '過中點觸發，回到中點以下停止' },
            ]}
          />
        </div>
      )

    case 'show':
      return <ActionPicker value={action.action} onChange={(a) => onChange({ ...action, action: a })} />

    case 'cue':
      return (
        <div className="space-y-2">
          <select className={selectClass} value={action.cueId} onChange={(e) => onChange({ ...action, cueId: e.target.value })}>
            <option value="">— 選擇 Cue —</option>
            {cues.map((c) => (
              <option key={c.id} value={c.id}>
                Q{c.cueNumber} · {c.title}
              </option>
            ))}
          </select>
          <Segmented<'go' | 'stop'>
            columns={2}
            value={action.command}
            onChange={(command) => onChange({ ...action, command })}
            options={[
              { id: 'go', label: 'GO 此 Cue' },
              { id: 'stop', label: 'Stop 此 Cue', description: '用它的 Fade Out' },
            ]}
          />
        </div>
      )

    case 'master':
      return <p className="text-xs text-white/40">推桿位置（最小值→最大值）對應 Master 0–100%，同步到所有觀眾裝置。</p>

    case 'midi':
      return (
        <div className="space-y-3">
          <select
            className={selectClass}
            value={action.message}
            onChange={(e) => onChange({ ...action, message: e.target.value as MidiMessage })}
          >
            {(Object.keys(MIDI_MESSAGE_LABELS) as MidiMessage[]).map((m) => (
              <option key={m} value={m}>
                {MIDI_MESSAGE_LABELS[m]}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Channel" suffix="" step={1} stepperStep={1} min={1} max={16} value={action.channel} onChange={(v) => onChange({ ...action, channel: Math.round(v) })} />
            <NumberField
              label={action.message === 'cc' ? 'CC #' : action.message === 'program' ? 'Program' : 'Note'}
              suffix=""
              step={1}
              stepperStep={1}
              max={127}
              value={action.number}
              onChange={(v) => onChange({ ...action, number: Math.round(v) })}
            />
          </div>
          {widget.type === 'button' && action.message !== 'program' && action.message !== 'noteOff' && (
            <NumberField
              label={action.message === 'cc' ? 'Value' : 'Velocity'}
              suffix=""
              step={1}
              stepperStep={1}
              max={127}
              value={action.value}
              onChange={(v) => onChange({ ...action, value: Math.round(v) })}
            />
          )}
          {widget.type !== 'button' && <p className="text-[11px] text-white/35">{widget.type === 'knob' ? '旋鈕' : '推桿'}位置會換算成 0–127 送出。</p>}
        </div>
      )

    case 'panel':
      return (
        <div className="space-y-3" data-panel-action>
          <Segmented<PanelTarget>
            columns={3}
            value={action.panel}
            onChange={(panel) => onChange({ ...action, panel })}
            options={(Object.keys(PANEL_LABELS) as PanelTarget[]).map((id) => ({ id, label: PANEL_LABELS[id] }))}
          />
          <Segmented<PanelMode>
            columns={3}
            value={action.mode}
            onChange={(mode) => onChange({ ...action, mode })}
            options={(Object.keys(PANEL_MODE_LABELS) as PanelMode[]).map((id) => ({ id, label: PANEL_MODE_LABELS[id] }))}
          />
          <p className="text-[11px] text-white/35">在主控台按下時，開關這個頁面上的視窗（Set Cue 畫面或控制面板）；MIDI / OSC 遠端按下也有效。</p>
        </div>
      )

    case 'osc':
      return (
        <div className="space-y-3">
          <label className="block">
            <Label>OSC Address</Label>
            <ImeInput
              className={`${fieldClass} font-mono`}
              value={action.address}
              placeholder="/qlab/go"
              onValueChange={(address) => onChange({ ...action, address })}
            />
          </label>
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <label className="block">
              <Label hint="空白 = 控台預設">目標 IP</Label>
              <ImeInput
                className={`${fieldClass} font-mono text-xs`}
                value={action.host}
                placeholder={defaultOscTarget || '例如 100.64.0.5'}
                onValueChange={(host) => onChange({ ...action, host })}
              />
            </label>
            <label className="block">
              <Label>Port</Label>
              <input
                className={`${fieldClass} font-mono text-xs`}
                inputMode="numeric"
                value={action.port || ''}
                placeholder="預設"
                onChange={(e) => onChange({ ...action, port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
              />
            </label>
          </div>
          <div className="space-y-2">
            <Label hint="$value = 推桿值 / 按下 1、放開 0">參數</Label>
            {action.args.map((arg, i) => (
              <div key={i} className="flex gap-2">
                <select
                  className={`${selectClass} w-24 shrink-0`}
                  value={arg.type}
                  onChange={(e) =>
                    onChange({ ...action, args: action.args.map((a, j) => (j === i ? { ...a, type: e.target.value as OscArgType } : a)) })
                  }
                >
                  {(Object.keys(OSC_ARG_LABELS) as OscArgType[]).map((t) => (
                    <option key={t} value={t}>
                      {OSC_ARG_LABELS[t]}
                    </option>
                  ))}
                </select>
                {arg.type !== 'T' && arg.type !== 'F' && (
                  <ImeInput
                    className={`${fieldClass} font-mono text-xs`}
                    value={arg.value}
                    placeholder={widget.type !== 'button' ? '$value' : '值'}
                    onValueChange={(value) => onChange({ ...action, args: action.args.map((a, j) => (j === i ? { ...a, value } : a)) })}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onChange({ ...action, args: action.args.filter((_, j) => j !== i) })}
                  className="min-h-11 shrink-0 rounded-lg px-3 text-white/35 hover:bg-white/10"
                  aria-label="移除參數"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => onChange({ ...action, args: [...action.args, { type: 'f', value: widget.type !== 'button' ? '$value' : '1' }] })}
              className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10"
            >
              ＋ 參數
            </button>
          </div>
        </div>
      )
  }
}

/** Where a knob / fader parameter lives: the show's audio (audience devices) or a DAW Studio. */
function ParamFields({ target, projectId, onChange }: { target: ParamTarget; projectId: string; onChange: (t: ParamTarget) => void }) {
  const studios = useStudioList(projectId)
  const studio = useStudio(projectId, target.scope === 'studio' ? target.studioId || null : null)
  const tracks = studio ? Object.values(studio.tracks).sort((a, b) => a.order - b.order) : []
  return (
    <div className="space-y-2">
      <Segmented<'show' | 'studio'>
        columns={2}
        value={target.scope}
        onChange={(scope) =>
          onChange(scope === 'show' ? { scope, param: 'filter' } : { scope, studioId: studios?.[0]?.id ?? '', trackId: 'master', param: 'volume' })
        }
        options={[
          { id: 'show', label: '演出音訊', description: '觀眾端 / Stage 的 Master 與效果' },
          { id: 'studio', label: 'DAW Studio', description: '音軌或 Master' },
        ]}
      />
      {target.scope === 'show' ? (
        <select className={selectClass} value={target.param} onChange={(e) => onChange({ scope: 'show', param: e.target.value as ShowParam })} data-field="參數">
          {(Object.keys(SHOW_PARAMS) as ShowParam[]).map((p) => (
            <option key={p} value={p}>
              {SHOW_PARAMS[p].label}
            </option>
          ))}
        </select>
      ) : (
        <>
          <select className={selectClass} value={target.studioId} onChange={(e) => onChange({ ...target, studioId: e.target.value, trackId: 'master', param: 'volume' })} data-field="Studio">
            <option value="">— 選擇 Studio —</option>
            {(studios ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                🎚 {s.name}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            value={target.trackId}
            disabled={!target.studioId}
            onChange={(e) => onChange({ ...target, trackId: e.target.value, param: e.target.value === 'master' ? 'volume' : target.param })}
            data-field="音軌"
          >
            <option value="master">Master（Studio 總輸出）</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            value={target.param}
            disabled={target.trackId === 'master'}
            onChange={(e) => onChange({ ...target, param: e.target.value as StudioParam })}
            data-field="參數"
          >
            {(Object.keys(STUDIO_PARAMS) as StudioParam[]).map((p) => (
              <option key={p} value={p}>
                {STUDIO_PARAMS[p].label}
              </option>
            ))}
          </select>
        </>
      )}
      <p className="text-[11px] text-white/35">控制元件的整個行程對應參數範圍；雙擊旋鈕回到預設值。</p>
    </div>
  )
}
