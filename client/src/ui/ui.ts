/**
 * UI template + style helpers.
 *
 * Game UI in this client is built from plain .html + .css files that live
 * under `src/ui/<component>/`. Each component imports its template and
 * stylesheet as raw strings via Vite's `?raw` query, then uses the
 * helpers in this module to:
 *
 *   1. inject the CSS once per component (guarded by id so repeated
 *      calls don't spam the document head), and
 *   2. render the HTML template with `{{placeholder}}` substitution.
 *
 * The long-term plan is for games to ship their own copies of the html
 * and css files to override the default look, so templates should stay
 * self-contained (one root element, no cross-file assumptions). The
 * helpers here are deliberately minimal — they don't touch the DOM
 * beyond what each component does itself.
 */

/**
 * Append a `<style>` tag containing `css` to the document head, once.
 * Subsequent calls with the same `id` are no-ops, so it's safe to call
 * from every show/render entry point.
 */
export function injectStyle(id: string, css: string): void {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}

/**
 * Substitute `{{name}}` placeholders in `template` with values from
 * `vars`. Unknown placeholders are replaced with an empty string.
 *
 * Values are coerced to strings with `String(v)`. **No HTML escaping** —
 * callers must pre-escape user-controlled input before passing it in.
 * For trusted static content (frame numbers, scores) this is fine.
 */
export function renderTemplate(
    template: string,
    vars: Record<string, string | number> = {},
): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const v = vars[key];
        return v === undefined ? '' : String(v);
    });
}
