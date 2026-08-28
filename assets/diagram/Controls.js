import { h } from 'preact';

const DEFAULT_COUNT_MAJOR_ROUTES = 8;
const DEFAULT_TARGET_MAJOR_STOPS = 5;

export { DEFAULT_COUNT_MAJOR_ROUTES, DEFAULT_TARGET_MAJOR_STOPS };

export default function Controls({
  countMajorRoutes,
  targetMajorStops,
  onCountMajorRoutesChange,
  onTargetMajorStopsChange,
  onExportSvg,
  onExportPng,
  editMode,
  onEditModeToggle,
  onResetOverrides,
}) {
  const handleRouteCount = (e) => {
    const value = parseInt(e.target.value, 10);
    if (!Number.isNaN(value) && value > 0 && value <= 100)
      onCountMajorRoutesChange(value);
  };

  const handleRouteCountBlur = (e) => {
    const value = parseInt(e.target.value, 10);
    if (Number.isNaN(value) || value < 1)
      onCountMajorRoutesChange(DEFAULT_COUNT_MAJOR_ROUTES);
    else if (value > 100) onCountMajorRoutesChange(100);
  };

  const handleStopCount = (e) => {
    const value = parseInt(e.target.value, 10);
    if (!Number.isNaN(value) && value > 0 && value <= 50)
      onTargetMajorStopsChange(value);
  };

  const handleStopCountBlur = (e) => {
    const value = parseInt(e.target.value, 10);
    if (Number.isNaN(value) || value < 1)
      onTargetMajorStopsChange(DEFAULT_TARGET_MAJOR_STOPS);
    else if (value > 50) onTargetMajorStopsChange(50);
  };

  return (
    <div class="diagram-controls">
      {editMode && (
        <div class="diagram-edit-controls">
          <label class="control-group">
            <span class="control-label">Routes</span>
            <input
              type="number"
              min="1"
              max="100"
              value={countMajorRoutes}
              onChange={handleRouteCount}
              onBlur={handleRouteCountBlur}
              class="control-input"
            />
          </label>
          <label class="control-group">
            <span class="control-label">Stops</span>
            <input
              type="number"
              min="1"
              max="50"
              value={targetMajorStops}
              onChange={handleStopCount}
              onBlur={handleStopCountBlur}
              class="control-input"
            />
          </label>
          <button
            class="reset-overrides-button"
            onClick={onResetOverrides}
            title="Reset all manual diagram edits"
          >
            Reset edits
          </button>
        </div>
      )}
      <button
        class="export-button"
        onClick={onExportSvg}
        title="Export diagram as SVG"
      >
        Export SVG
      </button>
      <button
        class="export-button"
        onClick={onExportPng}
        title="Export diagram as PNG"
      >
        Export PNG
      </button>
      <button
        class={`edit-toggle-button${editMode ? ' edit-toggle-button--active' : ''}`}
        onClick={onEditModeToggle}
        title={editMode ? 'Finish editing' : 'Edit diagram'}
      >
        {editMode ? 'Done' : 'Edit'}
      </button>
    </div>
  );
}
