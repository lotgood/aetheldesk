const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

let mediaQuery = null;

/**
 * Read the user's motion preference without constructing a new MediaQueryList
 * in every render callback. The MediaQueryList updates its `matches` value
 * when the OS preference changes, so callers can stay synchronous and live.
 */
export function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  if (!mediaQuery) mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  return mediaQuery.matches;
}
