/**
 * Styles for the overlay, injected into its shadow root.
 *
 * The tokens below are redeclared rather than shared: this renders inside the
 * recorded page, whose context knows nothing of Dolly's palette, and a
 * stylesheet import can't reach across into a shadow root. Keep the values in
 * step with `components/ui/theme.css`, which is the palette everywhere else.
 */
export const OVERLAY_STYLES = `
:host {
  --dolly-accent: #7d6aff;
  --dolly-selected: #c4b5fd;
  --dolly-accent-glow: rgba(125, 106, 255, 0.14);
  --dolly-accent-glow-strong: rgba(125, 106, 255, 0.2);
  --dolly-surface: #1e1e24;
  --dolly-divider: #2a2a30;
  --dolly-text: #e5e5e5;

  /* A custom element is inline by default, and the rectangles position against
     this box. Declaring display here overrides the UA rule for [hidden], hence
     the :host([hidden]) rule below. */
  display: block;
  /* Anchored to the document origin with no size, so the rectangles inside are
     placed in document coordinates and scroll with their content. Fixed would
     pin them to the viewport. */
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483647;
  /* Inert layer: only the rectangles take pointer input, so the page underneath
     stays clickable. */
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    'Helvetica Neue', sans-serif;
}

:host([hidden]) {
  display: none;
}

/* Output: stays visible while a shot plays or records. */
.dolly-stage {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* Editing UI. Hidden while a pose is active, so no frame catches it. */
.dolly-chrome[hidden] {
  display: none;
}

.dolly-cursor {
  position: absolute;
  overflow: visible;
  pointer-events: none;
  /* Lifts the glyph off light and dark pages alike. */
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
}

.dolly-cursor-handle {
  position: absolute;
  pointer-events: auto;
  cursor: move;
}
.dolly-cursor-handle__glyph {
  display: block;
  overflow: visible;
  opacity: 0.75;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
}
.dolly-cursor-handle--selected .dolly-cursor-handle__glyph {
  opacity: 1;
}
.dolly-cursor-handle--selected {
  outline: 1px dashed var(--dolly-selected);
  outline-offset: 2px;
}
.dolly-cursor-handle__label {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 4px;
  background: var(--dolly-accent);
  color: white;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.dolly-cursor-handle__label:hover {
  filter: brightness(1.1);
}
.dolly-cursor-handle__caret {
  opacity: 0.85;
  flex-shrink: 0;
}

/* Opens below the glyph: dropping upward gets clipped near the top of the page. */
.dolly-cursor-picker {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  min-width: 132px;
  border-radius: 8px;
  background: var(--dolly-surface);
  border: 1px solid var(--dolly-divider);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}
.dolly-cursor-picker__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dolly-text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dolly-cursor-picker__item:hover {
  background: rgba(255, 255, 255, 0.07);
}
.dolly-cursor-picker__item.is-active {
  background: var(--dolly-accent-glow-strong);
  color: #ffffff;
}
/* The swatches are dark-on-dark otherwise — the glyphs are black outlines. */
.dolly-cursor-picker__item svg {
  flex-shrink: 0;
  overflow: visible;
  filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.9));
}

.dolly-cursor-handle__scale {
  position: absolute;
  right: -6px;
  bottom: -6px;
  width: 12px;
  height: 12px;
  background: white;
  border: 2px solid var(--dolly-accent);
  border-radius: 3px;
  cursor: nwse-resize;
}

.dolly-guide {
  position: absolute;
  pointer-events: none;
  background: var(--dolly-selected);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.35);
}
.dolly-guide--x {
  width: 1px;
}
.dolly-guide--y {
  height: 1px;
}

.dolly-focus-rect {
  position: absolute;
  border: 2px solid var(--dolly-accent);
  background: var(--dolly-accent-glow);
  cursor: move;
  pointer-events: auto;
  box-sizing: border-box;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.dolly-focus-rect * {
  box-sizing: border-box;
}

.dolly-focus-rect--selected {
  border-color: var(--dolly-selected);
  background: var(--dolly-accent-glow-strong);
}

.dolly-focus-rect__label {
  position: absolute;
  top: -24px;
  left: 0;
  background: var(--dolly-accent);
  color: white;
  padding: 3px 9px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  pointer-events: none;
  white-space: nowrap;
  letter-spacing: 0.01em;
}

.dolly-focus-rect__handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: white;
  border: 2px solid var(--dolly-accent);
  border-radius: 3px;
}
.dolly-focus-rect__handle--nw {
  top: -7px;
  left: -7px;
  cursor: nwse-resize;
}
.dolly-focus-rect__handle--ne {
  top: -7px;
  right: -7px;
  cursor: nesw-resize;
}
.dolly-focus-rect__handle--sw {
  bottom: -7px;
  left: -7px;
  cursor: nesw-resize;
}
.dolly-focus-rect__handle--se {
  bottom: -7px;
  right: -7px;
  cursor: nwse-resize;
}
`;
