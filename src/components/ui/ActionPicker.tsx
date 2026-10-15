import { ACTION_GROUPS, type ShowAction } from '../../types/actions'
import { fieldClass } from './controls'

/** Grouped dropdown of the standard show-control actions. */
export function ActionPicker({ value, onChange }: { value: ShowAction; onChange: (action: ShowAction) => void }) {
  return (
    <div className="relative">
      <select
        className={`${fieldClass} appearance-none pr-9`}
        value={value}
        onChange={(e) => onChange(e.target.value as ShowAction)}
        aria-label="動作"
      >
        {ACTION_GROUPS.map((group) =>
          group.label ? (
            <optgroup key={group.label} label={group.label}>
              {group.actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.hint ? ` — ${a.hint}` : ''}
                </option>
              ))}
            </optgroup>
          ) : (
            group.actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))
          ),
        )}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-white/40">▾</span>
    </div>
  )
}
