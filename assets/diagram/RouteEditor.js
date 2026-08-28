import { h } from 'preact';
import {
  DEFAULT_BRANCH_CONFIG,
  isDefaultBranchConfig,
} from './branching.mjs';

export default function RouteEditor({
  value,
  onChange,
  onApply,
  onSplit,
  onRemove,
  onClose,
}) {
  const setBranch = (key, rawValue) =>
    onChange({
      ...value,
      branch: { ...value.branch, [key]: Number(rawValue) },
    });

  return (
    <form
      class="editor-popover editor-route-menu"
      role="dialog"
      aria-label="Edit route"
      style={{ left: `${value.left}px`, top: `${value.top}px` }}
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          routeId: value.routeId,
          label: value.label.trim() || value.routeId,
          trackKey: value.trackKey,
          branchOverride: isDefaultBranchConfig(value.branch)
            ? null
            : value.branch,
        });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      {value.name && <div class="editor-route-name">{value.name}</div>}
      <label class="editor-route-field">
        <span>Route label</span>
        <input
          class="editor-route-input"
          value={value.label}
          autoFocus
          onInput={(event) =>
            onChange({ ...value, label: event.currentTarget.value })
          }
        />
      </label>

      {value.trackKey && (
        <fieldset class="editor-branch-fields">
          <legend>Line branching</legend>
          <label>
            <span>
              Angle <output>{value.branch.angle}°</output>
            </span>
            <input
              type="range"
              aria-label="Branch angle"
              min="15"
              max="75"
              step="1"
              value={value.branch.angle}
              onInput={(event) => setBranch('angle', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>
              Length <output>{value.branch.length}%</output>
            </span>
            <input
              type="range"
              aria-label="Branch length"
              min="40"
              max="200"
              step="5"
              value={value.branch.length}
              onInput={(event) =>
                setBranch('length', event.currentTarget.value)
              }
            />
          </label>
          <div class="editor-branch-hint">
            Angle controls the slope; length stretches the transition.
          </div>
          <button
            type="button"
            class="editor-menu-btn"
            onClick={() =>
              onChange({ ...value, branch: { ...DEFAULT_BRANCH_CONFIG } })
            }
          >
            Reset branching
          </button>
        </fieldset>
      )}

      <button type="button" class="editor-menu-btn" onClick={onSplit}>
        Split onto its own track
      </button>
      <button
        type="button"
        class="editor-menu-btn editor-menu-btn--danger"
        onClick={onRemove}
      >
        Remove route
      </button>
      <div class="editor-dialog-actions">
        <button type="button" class="editor-menu-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" class="editor-primary-button">
          Apply
        </button>
      </div>
    </form>
  );
}
