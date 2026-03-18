import { trackEventWithContext } from "./track";

/**
 * Sets up global GA event tracking for DOM elements using `data-ga-*` attributes.
 *
 * 🔍 This enables declarative analytics tracking by simply adding attributes to HTML elements.
 * You can limit tracking to specific DOM event types (e.g., "click") both globally and per-element.
 *
 *  Example usage (in _app.tsx or layout):
 *   useEffect(() => {
 *     const teardown = setupGAAttributeEventTracking(["click", "submit"]);
 *     return teardown; // cleanup on unmount
 *   }, []);
 *
 * Example usage:
 *   <button
 *     data-ga-action="signup_click"
 *     data-ga-label="nav_button"
 *     data-ga-category="cta"
 *     data-ga-event-types="click"
 *   >
 *     Sign Up
 *   </button>
 *
 * Supported data attributes:
 *   - `data-ga-action` (required): GA action name
 *   - `data-ga-label`  (optional): GA label
 *   - `data-ga-category` (optional): GA category (defaults to event type)
 *   - `data-ga-event-types` (optional): comma-separated list of allowed event types for this element (e.g. "click,submit")
 *
 * @param globalEventTypes - Array of DOM event types to listen for globally (default: ["click", "change", "submit", "mouseenter"])
 * @returns Cleanup function to remove all added event listeners
 */
export function setupGAAttributeEventTracking(
  globalEventTypes: string[] = ["click", "change", "submit", "mouseenter"]
): () => void {
  const handler = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const el = target.closest("[data-ga-action]") as HTMLElement | null;
    if (!el) return;

    const action = el.dataset.gaAction;
    if (!action) return;

    // Check if this element has a restricted set of allowed event types
    const allowedTypes = el.dataset.gaEventTypes
      ?.split(",")
      .map((t) => t.trim());
    if (allowedTypes && !allowedTypes.includes(e.type)) {
      return; // This event type is not allowed for this element
    }

    const label = el.dataset.gaLabel;
    const category = el.dataset.gaCategory || e.type; // Default category to event type if not provided

    // Construct event parameters for GA4
    const eventParams = {
      category,
      label,
      url: window.location.href,
      windowPathname: window.location.pathname,
    };

    trackEventWithContext(action, category, label);
  };

  // Add event listeners
  globalEventTypes.forEach((eventType) => {
    document.addEventListener(eventType, handler, true); // Use `true` for capture phase to catch events early
  });

  // Return cleanup function
  return () => {
    globalEventTypes.forEach((eventType) => {
      document.removeEventListener(eventType, handler, true);
    });
  };
}
