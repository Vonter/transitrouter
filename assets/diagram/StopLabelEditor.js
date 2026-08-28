import { h } from 'preact';
import { STOP_ICON_OPTIONS, orderedStopIconTypes } from './stopIcons';

const sameList = (a, b) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function usableColor(value) {
  if (/^#[0-9a-f]{6}$/i.test(value || '')) return value;
  if (/^#[0-9a-f]{3}$/i.test(value || ''))
    return `#${[...value.slice(1)].map((char) => char.repeat(2)).join('')}`;
  return String(value).toLowerCase() === 'yellow' ? '#ffff00' : '#1b4da9';
}

export function createStopLabelEdit(stopId, name, detected, override, position) {
  const automaticTypes = STOP_ICON_OPTIONS.filter(({ type }) =>
    detected.has(type),
  ).map(({ type }) => type);
  return {
    stopId,
    name,
    ...position,
    types: override?.types
      ? orderedStopIconTypes(override.types)
      : automaticTypes,
    metroColor: usableColor(
      override?.metroColor || detected.get('metro')?.color,
    ),
    automaticTypes,
    automaticMetroColor: usableColor(detected.get('metro')?.color),
  };
}

export default function StopLabelEditor({ value, onChange, onApply, onClose }) {
  const toggle = (type) =>
    onChange({
      ...value,
      types: value.types.includes(type)
        ? value.types.filter((item) => item !== type)
        : orderedStopIconTypes([...value.types, type]),
    });

  const submit = (event) => {
    event.preventDefault();
    const types = orderedStopIconTypes(value.types);
    const automaticTypes = orderedStopIconTypes(value.automaticTypes);
    const colorChanged =
      types.includes('metro') &&
      value.metroColor.toLowerCase() !== value.automaticMetroColor.toLowerCase();
    onApply({
      stopId: value.stopId,
      name: value.name.trim(),
      iconOverride:
        sameList(types, automaticTypes) && !colorChanged
          ? null
          : { types, metroColor: value.metroColor },
    });
  };

  return (
    <form
      class="editor-popover editor-stop-menu"
      role="dialog"
      aria-label="Edit stop label"
      style={{ left: `${value.left}px`, top: `${value.top}px` }}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      <div class="editor-stop-menu-title">Edit stop label</div>
      <label class="editor-stop-name-field">
        <span>Stop name</span>
        <input
          class="editor-route-input"
          value={value.name}
          autoFocus
          required
          onInput={(event) =>
            onChange({ ...value, name: event.currentTarget.value })
          }
        />
      </label>
      <fieldset class="editor-stop-icons-field">
        <legend>Icons beside the name</legend>
        <div class="editor-stop-icon-options">
          {STOP_ICON_OPTIONS.map(({ type, label, glyph }) => {
            const selected = value.types.includes(type);
            return (
              <button
                key={type}
                type="button"
                class={`editor-stop-icon-option${
                  selected ? ' editor-stop-icon-option--selected' : ''
                }`}
                aria-pressed={selected}
                onClick={() => toggle(type)}
              >
                <span
                  class={`editor-stop-icon-glyph editor-stop-icon-glyph--${type}`}
                  style={
                    type === 'metro' ? { background: value.metroColor } : null
                  }
                >
                  {glyph}
                </span>
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>
      {value.types.includes('metro') && (
        <label class="editor-metro-color-field">
          <span>Metro line color</span>
          <span class="editor-metro-color-control">
            <input
              type="color"
              value={value.metroColor}
              onInput={(event) =>
                onChange({ ...value, metroColor: event.currentTarget.value })
              }
            />
            <code>{value.metroColor.toUpperCase()}</code>
          </span>
        </label>
      )}
      <div class="editor-stop-menu-actions">
        <button
          type="button"
          class="editor-menu-btn"
          onClick={() =>
            onChange({
              ...value,
              types: [...value.automaticTypes],
              metroColor: value.automaticMetroColor,
            })
          }
        >
          Use detected
        </button>
        <span class="editor-dialog-actions">
          <button type="button" class="editor-menu-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="editor-primary-button">
            Apply
          </button>
        </span>
      </div>
    </form>
  );
}
