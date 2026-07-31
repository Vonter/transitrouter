import { CupertinoPane } from 'cupertino-pane';

// Mirrors the BREAKPOINT()/supportsTouch gate in app.js — panes only ever
// run on touch + mobile-width; desktop keeps the CSS floating-card behavior.
export const paneAppliesHere = (supportsTouch, breakpoint) =>
  supportsTouch && !breakpoint();

// Content-aware breaks: starts at half the screen (or shorter, if the
// content itself is shorter than that), and only exposes a "top" break to
// drag up to if the content actually needs more than half the screen,
// capped just short of true fullscreen.
//
// A previous pane instance against this same element (destroy() doesn't
// clean up the inline `height` it force-set on the `[overflow-y]` region —
// only the wrapper/style tag/rendered flag) leaves that region's height
// pinned to whatever it was sized to *then*. Reset it before measuring, or
// this reads back that stale forced height as if it were the new content's
// natural size — permanently wrong until reloaded, since destroy+rebuild
// never gets a chance to see the real number.
function computeBreaks(el) {
  const scrollEl = el.querySelector('[overflow-y]');
  const prevHeight = scrollEl?.style.height;
  if (scrollEl) scrollEl.style.height = 'auto';
  const contentHeight = el.scrollHeight;
  if (scrollEl) scrollEl.style.height = prevHeight || '';

  const vh = window.innerHeight;
  const maxTop = Math.round(vh * 0.9);
  const middleHeight = Math.min(contentHeight, Math.round(vh * 0.5));
  const topHeight = Math.min(contentHeight, maxTop);

  // "bottom" is a real resting peek (handle+header only) rather than a
  // 0-height dismiss threshold — the footer and scrollable body hide
  // themselves from there (see onBreakChange in app.js and the .pane's own
  // overflow:hidden, which clips the rest of the content out of view once
  // the sheet is this short). Actual dismissal still happens via
  // bottomClose/fastSwipeClose — dragging *past* this break, or a fast
  // swipe — not by merely resting here.
  const handle = el.querySelector('.popover-handle');
  const header = el.querySelector('header');
  const peekHeight = (handle?.offsetHeight || 0) + (header?.offsetHeight || 0);

  return {
    top: { enabled: topHeight > middleHeight + 4, height: topHeight },
    middle: { enabled: true, height: middleHeight },
    bottom: { enabled: true, height: Math.min(peekHeight, middleHeight) },
  };
}

// Search's breaks are fixed proportions of the viewport, not measured from
// content — its list length varies with every keystroke, and unlike
// stop/service/between/location it's never auto-sized: callers drive its
// break explicitly (focus → top, keyboard dismiss → middle, map tap →
// bottom — see app.js), so there's nothing to measure against in the first
// place. "bottom" here is a resting/collapsed state, not a dismiss
// threshold (see bottomClose:false in its pane options below) — search is
// meant to always stay at least partly visible (the input bar itself)
// whenever no other popover has taken it over, so its "bottom" is a small
// peek, not fully off-screen the way stop/service/between/location's is.
export function computeSearchBreaks(el) {
  const vh = window.innerHeight;
  // .popover-search's own min-height (see app.css) — showing at least this
  // much keeps the input bar itself on screen and tappable at "bottom".
  const peekHeight = 60;
  return {
    top: { enabled: true, height: Math.max(0, vh - 80) },
    middle: { enabled: true, height: Math.round(vh * 0.45) },
    bottom: { enabled: true, height: peekHeight },
  };
}

// cupertino-pane's setOverflowHeight() assumes the scrollable `[overflow-y]`
// region is the *last* element in the pane — it sizes it to fill all
// remaining space below it with no accounting for anything after (our
// `.popover-footer`, holding the Arrivals/passing-routes button). Left
// alone, that pushes the footer below the pane's own clipped height
// entirely. Re-measure and pass the trailing siblings' total height as the
// offset setOverflowHeight already supports, so the scroll region leaves
// room for them.
function fixOverflowHeight(pane, el) {
  // Guards a genuine race: this runs from a present()/setBreakpoints()
  // .then(), which can fire after this exact pane has already been
  // destroyed by a rapid subsequent switch (syncMobilePane tears down
  // and rebuilds on every content change — see its comment). A destroyed
  // pane's overflowEl was never set (or is stale), so skip rather than
  // throw on `.style` of undefined.
  if (!pane?.overflowEl) return;
  const scrollEl = el.querySelector('[overflow-y]');
  let trailingHeight = 0;
  if (scrollEl) {
    let sib = scrollEl.nextElementSibling;
    while (sib) {
      trailingHeight += sib.offsetHeight;
      sib = sib.nextElementSibling;
    }
  }
  pane.setOverflowHeight?.(trailingHeight);
}

// `paneOptions` (passed through from syncMobilePane's caller) lets a
// popover override the handful of things search needs different from
// stop/service/between/location's defaults — see the search wiring in
// app.js for the one place that does.
function buildPane(el, onDismiss, paneOptions = {}) {
  const {
    // cupertino-pane resolves `dragBy` selectors with a plain, unscoped
    // `document.querySelector` — every popover shares the `.popover-handle`
    // class, so an unqualified selector here would grab whichever popover's
    // handle happens to appear first in the DOM instead of this one's own.
    // Scoping by this element's id keeps each pane wired to its own handle.
    //
    // Includes `header` alongside the handle: the handle bar alone is a
    // small target (~13px tall), and a drag starting a few pixels off it
    // was landing on plain, undraggable content — with no `touch-action`
    // override there, the browser's own default touch handling (page
    // scroll / pull-to-refresh) won racing against cupertino's touchstart
    // listener, instead of the sheet actually grabbing the gesture. cupertino
    // already excludes real form controls (button/input/select/etc — see
    // isFormElement() in its Events class) from starting a drag even when
    // they're inside a dragBy target, so buttons/links in the header stay
    // tappable normally.
    //
    // Pass `dragHandleSelector: null` (or `[]`) to disable drag entirely —
    // search has neither a .popover-handle nor a header worth dragging by,
    // and opts out of bottomClose/fastSwipeClose too (see app.js).
    dragHandleSelector = el.id
      ? [`#${el.id} .popover-handle`, `#${el.id} header`]
      : ['.popover-handle', 'header'],
    computeBreaksFn = computeBreaks,
    initialBreak = 'middle',
    // cupertino treats bottomClose as "any drag whose *closest* resting
    // point is bottom destroys the pane immediately" — not "dragging past
    // bottom dismisses". With a real bottom break now in play (see
    // computeBreaks above), true meant bottom could never actually be
    // rested at: landing near it destroyed the pane, landing further away
    // snapped back to middle instead.
    //
    // fastSwipeClose is still the right mechanism for "a genuine fast
    // swipe dismisses" — the problem was never that it exists, only that
    // the *trigger* for it (fastSwipeNext(), in the library's Events
    // class) isn't a real velocity check: it just compares the last two
    // recorded touchmove steps and fires whenever that last step moved
    // >= fastSwipeSensivity further than the one before it, regardless of
    // how much time elapsed between them. At the library's own default
    // (3px), an ordinary, unhurried drag's last recorded frame clears that
    // trivially — so it wasn't distinguishing "flicked it" from "gently
    // let go while still moving" at all, and was firing on nearly every
    // drag release. Raising the threshold to something only a genuinely
    // fast flick's last frame would clear (as opposed to a drag that's
    // decelerating into a deliberate rest) is the only lever the library
    // exposes for this — there's no true velocity/time-based option.
    // May need retuning against a real device; this is a starting point,
    // not a measured constant.
    bottomClose = false,
    fastSwipeClose = true,
    fastSwipeSensivity = 20,
    // Fires with the pane's new resting break name whenever a drag or
    // moveToBreak() settles — lets the caller react to "resting at bottom"
    // (e.g. hide a floating footer that lives outside the pane's own
    // clipped content) without this module knowing anything about that
    // caller-specific UI.
    onBreakChange,
  } = paneOptions;
  const dragBySelectors = dragHandleSelector
    ? (Array.isArray(dragHandleSelector) ? dragHandleSelector : [dragHandleSelector])
    : [];

  // el.parentElement right now is React's real, owned parent for this
  // element — capture it before cupertino moves el anywhere, so destroy()
  // can be corrected back to it (see the note on parentElement below).
  const reactOwnedParent = el.parentElement;

  const pane = new CupertinoPane(el, {
    // Not el.parentElement directly: that's a React-managed DOM node, and
    // cupertino inserts its wrapper as a plain child of whatever
    // parentElement is, entirely outside React's virtual DOM. If that
    // specific parent ever re-renders for an unrelated reason (e.g.
    // between's async route results arriving), React reconciles its own
    // children against a wrapper it has no record of creating and can
    // remove it as collateral damage — document.body is never reconciled
    // by this app's component tree, so it can't be touched by a render.
    // destroy() restores el into *this* same parentElement afterward
    // though, which would leave it under body instead of back in React's
    // tree — syncMobilePane corrects that using reactOwnedParent below.
    parentElement: document.body,
    backdrop: false,
    showDraggable: false,
    // cupertino's own `.pane` wrapper ships an opaque white background —
    // our content div supplies its own translucent/blurred background, so
    // that opaque layer sits behind it and defeats the blur. Tagged here so
    // app.css can neutralize it (see `.popover-pane-wrapper .pane`).
    cssClass: 'popover-pane-wrapper',
    dragBy: dragBySelectors,
    buttonDestroy: false,
    bottomClose,
    fastSwipeClose,
    fastSwipeSensivity,
    // cupertino-pane's default only allows the content to scroll once
    // fully expanded to the "top" break — since we start at "middle" and
    // may not even have a "top" break for short content, the list needs to
    // stay scrollable regardless of which break it's resting at.
    topperOverflow: false,
    initialBreak,
    breaks: computeBreaksFn(el),
    events: {
      onDidDismiss: () => pane._onDismiss?.(),
      // cupertino's own moveToBreak() only updates the bookkeeping
      // currentBreak() reads *after* this same transitionend-driven
      // promise resolves — so reading it synchronously from here (fired
      // from inside that same event, before the promise's continuation
      // runs) sees the *previous* break, one step behind, whenever this
      // was reached via moveToBreak() (a real drag updates that
      // bookkeeping earlier, before its own transition even starts, so
      // it isn't affected — only our own programmatic moves are). Defer
      // to a macrotask so the read happens after any pending microtasks,
      // moveToBreak's continuation included.
      onTransitionEnd: () => setTimeout(() => onBreakChange?.(pane.currentBreak()), 0),
    },
  });
  pane._onDismiss = onDismiss;
  pane._reactOwnedParent = reactOwnedParent;
  // Stashed so a later resize (see watchMobilePaneResize) can recompute
  // breaks with the same function this pane was actually built with —
  // search uses computeSearchBreaks, everything else computeBreaks.
  pane._computeBreaksFn = computeBreaksFn;
  return pane;
}

// Reverses the parentElement substitution above: destroy() (called with
// animate:false, so this runs synchronously — see destroyResets() in the
// library, reached with no prior await in that branch) puts el back under
// document.body, not React's real parent. Left there, React's next render
// of that parent won't find the child it expects and the tree desyncs.
function restoreToReactParent(pane, el) {
  if (pane?._reactOwnedParent && el.parentElement !== pane._reactOwnedParent) {
    pane._reactOwnedParent.appendChild(el);
  }
}

// destroy()'s promise resolves off a `transitionend` DOM event, which can
// resolve slightly out of step with the actual wrapper removal in
// destroyResets() (or, rarely, be delayed/dropped altogether — a known
// class of CSS transitionend flakiness). Waiting for that promise still
// isn't a hard guarantee no wrapper containing `el` remains in the DOM —
// and cupertino-pane's present() silently no-ops with just a console
// warning if it finds one, rather than erroring, so a still-there wrapper
// otherwise produces a "pane" that was never actually shown, with nothing
// pointing that out except a console message nobody's watching in
// production. Force the issue directly: before building a new pane,
// physically detach `el` from any wrapper still holding it.
function forceDetachStaleWrapper(el, fallbackParent) {
  document.querySelectorAll('.cupertino-pane-wrapper').forEach((wrapper) => {
    if (wrapper.contains(el)) {
      (fallbackParent || document.body).appendChild(el);
      wrapper.remove();
    }
  });
}

// --- syncMobilePane -----------------------------------------------------
//
// A CupertinoPane instance only ever does its real setup once: measuring
// content, wiring up the scrollable region, and building its breakpoints
// all happen inside present(), but only the *first* time a given instance
// is presented — every call after that takes a fast path that just moves
// to a breakpoint using whatever was computed way back then. Earlier
// versions of this module tried to keep one long-lived pane instance per
// popover and patch its internals back into sync on every reopen and every
// content change (setBreakpoints, setOverflowHeight, moveToBreak,
// ResizeObserver...). That produced a long tail of bugs — stale sizing
// carried over from a previous stop, headers cut off, scrolling that
// stopped working, sheets resting at the wrong breakpoint — because each
// patch covered one symptom without the reused instance ever being
// *actually* fresh the way a first-ever present() is.
//
// So: don't reuse. Every time a popover should be showing, tear down
// whatever pane instance is there (if any) and build a brand new one. This
// is a little more work per open, but it's the one code path that has
// always behaved correctly, and it means there is exactly one place
// (buildPane, above) that determines a pane's initial state — nothing
// downstream can leave it half-updated.
//
// `paneRef` is a plain `useRef(null)` — the ref's `.current` holds the live
// CupertinoPane instance (or null when not shown).
export function syncMobilePane(paneRef, el, shouldShow, { onDismiss, paneOptions } = {}) {
  // Bumped on every call, whether or not it ends up building anything —
  // this is what lets a later call cancel an earlier one's in-flight
  // teardown/rebuild chain below, however far it's gotten.
  const gen = (paneRef._gen || 0) + 1;
  paneRef._gen = gen;

  const prevPane = paneRef.current;
  paneRef.current = null;

  const buildIfStillWanted = () => {
    if (paneRef._gen !== gen) return; // superseded while we were tearing down
    if (!shouldShow || !el) return;

    el.classList.add('pane-managed');
    // destroy() leaves this element's inline `display: none` behind —
    // normally only undone by a *subsequent* present(), which happens
    // after we've already measured it below. Left alone, every rebuild
    // past the first measures a display:none element (always 0
    // scrollHeight) and ends up with degenerate breaks.
    el.style.display = '';
    // A stop/service/location switch commits its new content-driving state
    // in the same render that flips (or keeps) shouldShow true, but the
    // *children* rendering off that state (BusServicesArrival's own
    // data-dependent render) aren't guaranteed to have painted yet —
    // measuring synchronously here can catch the DOM mid-update, sometimes
    // seeing near-empty content and building a near-zero-height pane.
    // Waiting a couple of frames lets layout settle first.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (paneRef._gen !== gen || !el.isConnected) return;
        forceDetachStaleWrapper(el, prevPane?._reactOwnedParent);
        const pane = buildPane(el, onDismiss, paneOptions);
        paneRef.current = pane;
        pane.present({ animate: true }).then(() => {
          if (paneRef.current !== pane) return; // superseded/destroyed while presenting
          fixOverflowHeight(pane, el);
        });
      });
    });
  };

  if (prevPane) {
    // This teardown is either us closing (shouldShow is false — the caller
    // already knows and is about to update its own state) or us rebuilding
    // fresh for new content while staying "open" — neither is a real
    // user-initiated dismiss, so suppress onDidDismiss for it. The only
    // destroy() that should ever reach the live callback is one the
    // *library* triggers on its own, from an actual swipe past bottomClose.
    prevPane._onDismiss = null;
    if (prevPane.isPanePresented?.()) {
      // Wait for the old pane's destroy to actually finish (its own
      // present()-side warning: "specified selector or DOM element already
      // in use") before building a new one against the same element —
      // an *animated* destroy (a real close) takes ~300ms, but React can
      // fire the next "reopen with new content" effect within a couple of
      // frames of it starting. Racing a rebuild against that in-flight
      // teardown used to attach a second pane to an element whose old
      // wrapper hadn't been removed yet; present() would silently warn and
      // bail, leaving paneRef.current pointing at a pane that was never
      // actually shown.
      prevPane.destroy({ animate: shouldShow ? false : true }).then(() => {
        restoreToReactParent(prevPane, el);
        buildIfStillWanted();
      });
      return;
    }
  }
  buildIfStillWanted();
}

// Content can still change *within* a single open — most notably
// BusServicesArrival's live arrivals loading in async, well after this
// pane's initial breaks were computed from whatever had rendered by
// present()-time. Watches for actual DOM mutations (not size — once
// setOverflowHeight() force-sets the scroll region's height, its *size*
// stops changing even though its *content* still is, so a ResizeObserver
// would go silent after the first firing) and rebuilds breakpoints in
// place, without tearing down the pane (no need to — same content
// identity, just more/less of it).
//
// Call this once per popover, e.g. in the same effect that calls
// syncMobilePane, and use the returned cleanup on unmount/dep-change.
export function watchMobilePaneContent(paneRef, el) {
  if (!el || !window.MutationObserver) return () => {};
  const scrollEl = el.querySelector('[overflow-y]') || el;
  const observer = new MutationObserver(() => {
    const pane = paneRef.current;
    if (!pane?.isPanePresented?.()) return;
    const restingBreak = pane.currentBreak() || 'middle';
    pane.setBreakpoints(computeBreaks(el)).then(() => {
      if (paneRef.current !== pane) return; // superseded/destroyed meanwhile
      fixOverflowHeight(pane, el);
      // setBreakpoints/setOverflowHeight update the breakpoint table and
      // .pane's height, but a pane already resting at a breakpoint doesn't
      // reposition itself to match — its on-screen "reveal" is governed by
      // its transform, not its height, so without this the sheet wouldn't
      // visibly grow/shrink even though the numbers underneath just did.
      pane.moveToBreak(restingBreak);
    });
  });
  observer.observe(scrollEl, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

// A window resize/orientation change leaves a presented pane's breakpoints
// exactly as they were computed at build time — cupertino's own internal
// resize handler re-applies those same locked pixel heights rather than
// recomputing them (see ResizeEvents.onWindowResize/buildBreakpoints in the
// library), so a break like "middle: 50vh" silently goes stale the moment
// the viewport's actual height changes. Recompute for real and reapply,
// the same technique watchMobilePaneContent already uses for a content
// change instead of a size change.
//
// Call this once per popover alongside watchMobilePaneContent, and use the
// returned cleanup the same way.
export function watchMobilePaneResize(paneRef, el) {
  if (!el) return () => {};
  let rafId = null;
  const handler = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const pane = paneRef.current;
      if (!pane?.isPanePresented?.()) return;
      const restingBreak = pane.currentBreak() || 'middle';
      const breaksFn = pane._computeBreaksFn || computeBreaks;
      pane.setBreakpoints(breaksFn(el)).then(() => {
        if (paneRef.current !== pane) return; // superseded/destroyed meanwhile
        fixOverflowHeight(pane, el);
        pane.moveToBreak(restingBreak);
      });
    });
  };
  window.addEventListener('resize', handler);
  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', handler);
  };
}

// Small guarded wrapper for the programmatic break transitions search
// drives externally (focus → top, keyboard dismiss → middle, map tap →
// bottom) — a plain `paneRef.current?.moveToBreak(...)` would still throw
// cupertino's own "present pane before call moveToBreak()" warning if the
// pane hasn't been built yet (e.g. an event fires before the first
// present() resolves), and skip silently if it's already resting there.
export function movePaneToBreak(paneRef, breakName) {
  const pane = paneRef.current;
  if (!pane?.isPanePresented?.()) return;
  if (pane.currentBreak() === breakName) return;
  pane.moveToBreak(breakName);
}
