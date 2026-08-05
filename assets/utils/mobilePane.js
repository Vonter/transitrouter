import { CupertinoPane } from 'cupertino-pane';
import { rafThrottle } from './mapOptimizations';

// Mirrors the BREAKPOINT()/supportsTouch gate in app.js — panes only ever
// run on touch + mobile-width; desktop keeps the CSS floating-card behavior.
export const paneAppliesHere = (supportsTouch, breakpoint) =>
  supportsTouch && !breakpoint();

// Shortest list worth resting at. Half the screen is less than the sheet's
// own header on a short (landscape) viewport, which would otherwise leave a
// sheet with no list in it at all.
const MIN_LIST_HEIGHT = 96;

// Content-aware breaks: half the screen (or shorter, if the content is), and
// a "top" break to drag up to only if the content needs more than that,
// capped just short of fullscreen.
//
// destroy() leaves behind the inline `height` it force-set on the
// `[overflow-y]` region, so measuring without resetting it first reads that
// stale height back as the new content's natural size — permanently wrong,
// since every rebuild inherits it.
function computeBreaks(el) {
  const scrollEl = el.querySelector('[overflow-y]');
  const prevHeight = scrollEl?.style.height;
  if (scrollEl) scrollEl.style.height = 'auto';
  const contentHeight = el.scrollHeight;
  // Everything above the scroll region: handle, header, filter row.
  const chromeHeight = scrollEl
    ? scrollEl.getBoundingClientRect().top - el.getBoundingClientRect().top
    : 0;
  if (scrollEl) scrollEl.style.height = prevHeight || '';

  const vh = window.innerHeight;
  const maxTop = Math.round(vh * 0.9);
  const middleHeight = Math.min(
    contentHeight,
    maxTop,
    Math.max(Math.round(vh * 0.5), chromeHeight + MIN_LIST_HEIGHT),
  );
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

// Height of everything after the scroll region (our `.popover-footer`, with
// the Arrivals/passing-routes button). cupertino's setOverflowHeight()
// assumes nothing follows it, and would push the footer past the pane's own
// clipped height — it takes this back as an offset.
function trailingHeight(scrollEl) {
  let total = 0;
  for (let sib = scrollEl?.nextElementSibling; sib; sib = sib.nextElementSibling) {
    total += sib.offsetHeight;
  }
  return total;
}

// Break *heights* live in settings.breaks; breakpoints.breaks holds the
// derived translateY values instead.
const breakHeight = (pane, name) => pane?.settings?.breaks?.[name]?.height;
const tallestBreak = (pane) =>
  Object.values(pane?.settings?.breaks || {}).reduce(
    (max, b) => (b?.enabled ? Math.max(max, b.height || 0) : max),
    0,
  );

// cupertino sizes the scroll region to the *top* break, assuming content only
// scrolls fully expanded (its `topperOverflow` default, which we turn off so
// lists stay scrollable at every break). At any shorter break that leaves the
// region's last (top - current) pixels below the screen edge: unreachable
// however far you scroll, and not scrollable at all when the content is
// shorter than that inflated height. Size it to the break on screen instead.
//
// `height` defaults to the current break; callers pass the tallest one to
// pre-grow the region for a move that may end taller (see expandOverflow).
function sizeOverflow(pane, el, height) {
  // present()/setBreakpoints() continuations can land after a rapid switch
  // already destroyed this pane (syncMobilePane rebuilds on every content
  // change), leaving overflowEl unset.
  if (!pane?.overflowEl) return;
  const trailing = trailingHeight(el.querySelector('[overflow-y]'));
  // The library call still sizes `.pane` itself — correctly, to the top
  // break, since the sheet's background has to cover the whole drag range.
  pane.setOverflowHeight?.(trailing);
  const visible = height ?? breakHeight(pane, pane.currentBreak?.());
  if (visible == null) return;
  const { style, offsetTop } = pane.overflowEl;
  style.height = `${Math.max(0, visible - offsetTop - trailing)}px`;
}

// Grow to the tallest break for the duration of a drag or move: going up, the
// area being revealed is already filled; going down, the surplus is clipped
// by `.pane`'s own overflow:hidden.
const expandOverflow = (pane, el) =>
  sizeOverflow(pane, el, tallestBreak(pane) || undefined);

// Resizes a live pane in place — the shared body of both watchers below.
// Skipped when the breaks come back unchanged: live arrivals refresh on a timer
// but rarely change the sheet's height, and re-applying identical breaks still
// costs a 300ms reposition.
function reapplyBreaks(paneRef, el) {
  const pane = paneRef.current;
  if (!pane?.isPanePresented?.()) return;
  const breaks = (pane._computeBreaksFn || computeBreaks)(el);
  const breaksKey = JSON.stringify(breaks);
  if (breaksKey === pane._breaksKey) return;
  pane._breaksKey = breaksKey;

  const restingBreak = pane.currentBreak() || 'middle';
  pane.setBreakpoints(breaks).then(() => {
    if (paneRef.current !== pane) return; // superseded/destroyed meanwhile
    expandOverflow(pane, el);
    // A pane already resting at a break doesn't follow its own new numbers —
    // its reveal is governed by transform, not height. onTransitionEnd sizes
    // the scroll region once the move lands.
    pane.moveToBreak(breaks[restingBreak]?.enabled ? restingBreak : 'middle');
  });
}

// cupertino's keyboard handling has to go. fixBodyKeyboardResize() rewrites the
// document's `<meta name=viewport>` (plus html overflow / body min-height),
// relayouting the whole page — map canvas included — and firing another resize
// that re-enters the same path. destroyResets() calls it on every teardown, so
// it ran on ordinary sheet transitions too. onKeyboardShow/WillHide also move
// the sheet to heights of their own, fighting the breaks app.js drives from
// visualViewport. Nothing opts out (KeyboardEvents is a core class, not one of
// the optional `modules`), so blank the methods per instance.
function disableLibraryKeyboardHandling(pane) {
  const keyboard = pane?.keyboardEvents;
  if (!keyboard) return;
  keyboard.fixBodyKeyboardResize = () => {};
  keyboard.handleKeyboardFromResize = () => false; // false = carry on as a plain resize
  keyboard.onKeyboardShow = () => {};
  keyboard.onKeyboardWillHide = () => {};
}

// destroy() hands the element back still wearing cupertino's styles: display,
// an opacity transition, overflowX, and a forced height on `[overflow-y]`. The
// next present() overwrites them, so they only matter on the way out to desktop
// — where they'd override the floating-card CSS and leave it invisible and
// unanimated. `.pane-managed` goes too; it pins position:static.
function releaseToCSS(el) {
  if (!el) return;
  el.classList.remove('pane-managed');
  el.style.display = '';
  el.style.visibility = '';
  el.style.transition = '';
  el.style.overflowX = '';
  const scrollEl = el.querySelector('[overflow-y]');
  if (scrollEl) {
    scrollEl.style.height = '';
    scrollEl.style.overflowX = '';
    scrollEl.style.overscrollBehavior = '';
  }
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
    // Stacking order for this pane's wrapper. Without it the order is DOM
    // insertion order, which reverses between the two directions of a
    // handoff, putting the sheet meant to be underneath on top on the way
    // back.
    zIndex,
  } = paneOptions;
  const dragBySelectors = dragHandleSelector
    ? (Array.isArray(dragHandleSelector) ? dragHandleSelector : [dragHandleSelector])
    : [];

  // el.parentElement right now is React's real, owned parent for this
  // element — capture it before cupertino moves el anywhere, so destroy()
  // can be corrected back to it (see the note on parentElement below).
  const reactOwnedParent = el.parentElement;
  const breaks = computeBreaksFn(el);

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
    breaks,
    events: {
      onDidDismiss: () => pane._onDismiss?.(),
      // present() builds the wrapper: `rendered` is the first point it
      // exists and the last before the transition, so stacking is settled
      // before anything paints.
      rendered: () => {
        if (zIndex != null && pane.wrapperEl) pane.wrapperEl.style.zIndex = zIndex;
      },
      // A drag can end at any break, so size for the tallest throughout or
      // dragging up reveals a blank strip. onTransitionEnd shrinks it back.
      onDragStart: () => expandOverflow(pane, el),
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
      onTransitionEnd: () =>
        setTimeout(() => {
          if (!pane.isPanePresented?.()) return; // this was the dismiss transition
          sizeOverflow(pane, el);
          onBreakChange?.(pane.currentBreak());
        }, 0),
    },
  });
  disableLibraryKeyboardHandling(pane);
  pane._onDismiss = onDismiss;
  pane._reactOwnedParent = reactOwnedParent;
  // Stashed so a later resize (see watchMobilePaneResize) can recompute
  // breaks with the same function this pane was actually built with —
  // search uses computeSearchBreaks, everything else computeBreaks.
  pane._computeBreaksFn = computeBreaksFn;
  pane._breaksKey = JSON.stringify(breaks);
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
//
// `release` means "pane mode no longer applies" (crossed into desktop width)
// rather than "this popover is closed" — the element goes back under plain CSS
// instead of staying hidden by cupertino's leftovers.
//
// `animate` / `waitFor` hand one sheet over to another (see app.js). Two
// sheets animating at once, one down and one up, reads as a flicker; what
// works is one moving while the other holds still. `animate: false` opts
// this pane out of moving; `waitFor` holds its work back until the promise
// resolves, so the incoming sheet is fully up before this one is taken away.
//
// Returns a promise resolving once this call has settled — that's what the
// paired caller passes as its `waitFor`.
export function syncMobilePane(
  paneRef,
  el,
  shouldShow,
  { onDismiss, paneOptions, release, animate = true, waitFor } = {},
) {
  // Bumped on every call, whether or not it ends up building anything —
  // this is what lets a later call cancel an earlier one's in-flight
  // teardown/rebuild chain below, however far it's gotten.
  const gen = (paneRef._gen || 0) + 1;
  paneRef._gen = gen;

  const prevPane = paneRef.current;
  paneRef.current = null;
  // Clear any measure-window hiding a superseded call left behind (see below).
  if (el) el.style.visibility = '';

  const settle = () => new Promise((resolve) => {
    if (paneRef._gen !== gen) return resolve(); // superseded while we were tearing down
    if (!shouldShow || !el) {
      if (release) releaseToCSS(el);
      return resolve();
    }

    el.classList.add('pane-managed');
    // destroy() leaves this element's inline `display: none` behind —
    // normally only undone by a *subsequent* present(), which happens
    // after we've already measured it below. Left alone, every rebuild
    // past the first measures a display:none element (always 0
    // scrollHeight) and ends up with degenerate breaks.
    el.style.display = '';
    // Displayed but not visible: `.pane-managed` already dropped the element to
    // position:static, so until the CupertinoPane constructor re-hides it, it
    // paints as a plain block in normal flow — a two-frame flash on every
    // rebuild. visibility:hidden still measures, unlike display:none.
    el.style.visibility = 'hidden';
    // A stop/service/location switch commits its new content-driving state
    // in the same render that flips (or keeps) shouldShow true, but the
    // *children* rendering off that state (BusServicesArrival's own
    // data-dependent render) aren't guaranteed to have painted yet —
    // measuring synchronously here can catch the DOM mid-update, sometimes
    // seeing near-empty content and building a near-zero-height pane.
    // Waiting a couple of frames lets layout settle first.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (paneRef._gen !== gen || !el.isConnected) {
          el.style.visibility = '';
          return resolve();
        }
        forceDetachStaleWrapper(el, prevPane?._reactOwnedParent);
        // buildPane measures, then the constructor sets display:none — the
        // library owns visibility from here, so drop our inline override.
        const pane = buildPane(el, onDismiss, paneOptions);
        el.style.visibility = '';
        paneRef.current = pane;
        pane.present({ animate }).then(() => {
          if (paneRef.current === pane) sizeOverflow(pane, el);
          resolve();
        });
      });
    });
  });

  // Our own teardown is never a user dismiss, whether we're closing or just
  // rebuilding for new content — only a library-triggered destroy (a real
  // swipe past bottomClose) should reach the callback. Cleared synchronously,
  // before any waiting below.
  if (prevPane) prevPane._onDismiss = null;

  const run = () => {
    if (paneRef._gen !== gen) return Promise.resolve(); // superseded while held
    if (prevPane?.isPanePresented?.()) {
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
      //
      // Animate only a real close: a rebuild wants the element free now, and a
      // release is handing it to desktop CSS — neither should slide out first.
      return prevPane
        .destroy({ animate: animate && !shouldShow && !release })
        .then(() => {
          restoreToReactParent(prevPane, el);
          return settle();
        });
    }
    return settle();
  };

  return waitFor ? Promise.resolve(waitFor).then(run) : run();
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
  const reapply = rafThrottle(() => reapplyBreaks(paneRef, el));
  const observer = new MutationObserver(reapply);
  observer.observe(scrollEl, { childList: true, subtree: true, characterData: true });
  return () => {
    reapply.cancel();
    observer.disconnect();
  };
}

// A window resize/orientation change leaves a presented pane's breakpoints
// exactly as they were computed at build time — cupertino's own internal
// resize handler re-applies those same locked pixel heights rather than
// recomputing them (see ResizeEvents.onWindowResize/buildBreakpoints in the
// library), so a break like "middle: 50vh" silently goes stale the moment
// the viewport's actual height changes. Recompute for real and reapply.
//
// Gated on width, not height: a mobile viewport's height also changes for the
// keyboard and the collapsing URL bar, and re-measuring against those sized the
// sheet for a viewport it isn't living in — it jumped on every scroll and stole
// the breaks app.js drives while the keyboard is up. Orientation flips move the
// width too, and cupertino still re-anchors to the new screen height.
//
// Call this once per popover alongside watchMobilePaneContent, and use the
// returned cleanup the same way.
export function watchMobilePaneResize(paneRef, el) {
  if (!el) return () => {};
  let lastWidth = window.innerWidth;
  const reapply = rafThrottle(() => reapplyBreaks(paneRef, el));
  const handler = () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    reapply();
  };
  window.addEventListener('resize', handler);
  return () => {
    reapply.cancel();
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
  // As on drag start: pre-grow so a move to a taller break reveals content,
  // not a blank strip. onTransitionEnd settles it to the destination.
  expandOverflow(pane, pane.el);
  pane.moveToBreak(breakName);
}
