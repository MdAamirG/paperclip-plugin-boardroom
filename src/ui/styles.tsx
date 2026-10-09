/**
 * Boardroom styles. Plugin UI runs inside the host page, so the stylesheet uses only the host's
 * CSS custom properties (colors, radius, spacing unit, fonts) and `rem`, never hex or raw pixel
 * sizes. The fallbacks after each variable match the host defaults and only matter in isolation
 * (for example the plugin dev server). Class names are prefixed `br-` so they cannot clash.
 */
const SPACE = (n: number) => `calc(var(--spacing, 0.25rem) * ${n})`;

const css = `
.br-root { display: flex; flex-direction: column; gap: ${SPACE(6)}; padding: ${SPACE(4)}; color: var(--foreground); font-family: var(--font-sans, inherit); font-size: var(--text-sm, 0.875rem); line-height: 1.5; min-width: 0; }
.br-root h1, .br-root h2, .br-root h3, .br-root p, .br-root ul, .br-root ol, .br-root dl, .br-root dd, .br-root fieldset { margin: 0; padding: 0; }
.br-root ul, .br-root ol { list-style: none; }
.br-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: ${SPACE(3)}; }
.br-title { font-size: var(--text-xl, 1.25rem); font-weight: 600; line-height: 1.3; font-family: var(--font-heading, inherit); overflow-wrap: anywhere; }
.br-h2 { font-size: var(--text-sm, 0.875rem); font-weight: 600; }
.br-muted { color: var(--muted-foreground); }
.br-small { font-size: var(--text-xs, 0.75rem); }
.br-mono { font-family: var(--font-mono, monospace); }
.br-stack { display: flex; flex-direction: column; gap: ${SPACE(3)}; }
.br-row { display: flex; flex-wrap: wrap; align-items: center; gap: ${SPACE(2)}; }
.br-link { color: var(--foreground); text-decoration: underline; text-underline-offset: ${SPACE(0.5)}; }
.br-link:hover { color: var(--muted-foreground); }
.br-btn { display: inline-flex; align-items: center; justify-content: center; gap: ${SPACE(2)}; padding: ${SPACE(1.5)} ${SPACE(3)}; border: thin solid var(--border); border-radius: var(--radius-md, 0.375rem); background: transparent; color: var(--foreground); font: inherit; font-weight: 500; cursor: pointer; text-decoration: none; }
.br-btn:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground, var(--foreground)); }
.br-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.br-btn-primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
.br-btn-primary:hover:not(:disabled) { background: var(--primary); color: var(--primary-foreground); opacity: 0.9; }
.br-root :focus-visible, .br-nav :focus-visible { outline: medium solid var(--ring, currentColor); outline-offset: ${SPACE(0.5)}; }
.br-field { display: flex; flex-direction: column; gap: ${SPACE(1.5)}; min-width: 0; }
.br-label { font-weight: 500; }
.br-input { width: 100%; box-sizing: border-box; padding: ${SPACE(1.5)} ${SPACE(2.5)}; border: thin solid var(--input, var(--border)); border-radius: var(--radius-md, 0.375rem); background: transparent; color: inherit; font: inherit; }
.br-input[aria-invalid="true"] { border-color: var(--destructive); }
textarea.br-input { resize: vertical; min-height: ${SPACE(24)}; }
.br-grow { flex: 1; min-width: 0; }
.br-pick-button { display: block; width: 100%; padding: ${SPACE(2)} ${SPACE(3)}; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.br-pick-button:hover { background: var(--accent); }
.br-input-narrow { max-width: ${SPACE(32)}; }
.br-error-text { color: var(--destructive); }
.br-notice { padding: ${SPACE(3)}; border: thin solid var(--border); border-radius: var(--radius-md, 0.375rem); }
.br-notice-error { border-color: var(--destructive); color: var(--destructive); background: color-mix(in oklab, var(--destructive) 8%, transparent); }
.br-notice-warn { background: color-mix(in oklab, var(--muted) 60%, transparent); color: var(--foreground); }
.br-empty { display: flex; flex-direction: column; align-items: flex-start; gap: ${SPACE(3)}; padding: ${SPACE(8)}; border: thin dashed var(--border); border-radius: var(--radius-lg, 0.5rem); }
.br-table { width: 100%; border-collapse: collapse; }
.br-table th { text-align: left; font-weight: 500; color: var(--muted-foreground); padding: ${SPACE(2)} ${SPACE(3)}; border-bottom: thin solid var(--border); }
.br-table td { padding: ${SPACE(2.5)} ${SPACE(3)}; border-bottom: thin solid var(--border); vertical-align: middle; }
.br-table-wrap { overflow-x: auto; }
.br-num { text-align: right; font-variant-numeric: tabular-nums; }
.br-picked { display: flex; flex-direction: column; gap: ${SPACE(1)}; }
.br-pick-list { display: flex; flex-direction: column; border: thin solid var(--border); border-radius: var(--radius-md, 0.375rem); max-height: ${SPACE(72)}; overflow-y: auto; }
.br-pick-item { display: flex; align-items: center; gap: ${SPACE(2.5)}; padding: ${SPACE(2)} ${SPACE(3)}; border-bottom: thin solid var(--border); cursor: pointer; }
.br-pick-item:last-child { border-bottom: 0; }
.br-pick-item:hover { background: var(--accent); }
.br-chip { display: inline-flex; align-items: center; gap: ${SPACE(1.5)}; padding: ${SPACE(0.5)} ${SPACE(2)}; border: thin solid var(--border); border-radius: var(--radius-xl, 0.75rem); background: var(--muted); }
.br-chip button { padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.br-footer { display: flex; align-items: center; justify-content: space-between; gap: ${SPACE(3)}; padding-top: ${SPACE(4)}; border-top: thin solid var(--border); }
.br-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: ${SPACE(6)}; }
@media (min-width: 64rem) { .br-layout { grid-template-columns: minmax(0, 1fr) ${SPACE(80)}; } }
.br-region { display: flex; flex-direction: column; gap: ${SPACE(3)}; padding: ${SPACE(4)}; border: thin solid var(--border); border-radius: var(--radius-lg, 0.5rem); background: var(--card); color: var(--card-foreground, var(--foreground)); min-width: 0; }
.br-region-placeholder { color: var(--muted-foreground); }
.br-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: ${SPACE(1)} ${SPACE(4)}; }
.br-meta dt { color: var(--muted-foreground); }
.br-participants li { display: flex; flex-direction: column; padding: ${SPACE(2)} 0; border-bottom: thin solid var(--border); }
.br-participants li:last-child { border-bottom: 0; }
.br-nav { display: flex; align-items: center; gap: ${SPACE(2.5)}; padding: ${SPACE(2)} ${SPACE(3)}; color: color-mix(in oklab, var(--foreground) 80%, transparent); font-weight: 500; text-decoration: none; transition: background-color var(--motion-duration-fast, 0.15s); }
.br-nav:hover { background: color-mix(in oklab, var(--accent) 50%, transparent); color: var(--foreground); }
.br-nav[aria-current="page"] { background: var(--accent); color: var(--foreground); }
.br-icon { flex-shrink: 0; width: ${SPACE(4)}; height: ${SPACE(4)}; }
.br-transcript { display: flex; flex-direction: column; gap: ${SPACE(3)}; max-height: ${SPACE(120)}; overflow-y: auto; padding-right: ${SPACE(1)}; }
.br-message { display: flex; flex-direction: column; gap: ${SPACE(1)}; padding: ${SPACE(3)}; border: thin solid var(--border); border-radius: var(--radius-md, 0.375rem); min-width: 0; overflow-wrap: anywhere; }
.br-message[data-author-kind="agent"] { background: color-mix(in oklab, var(--muted) 40%, transparent); }
.br-message-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: ${SPACE(2)}; }
.br-composer-input { min-height: ${SPACE(24)}; }
.br-mention-list { display: flex; flex-direction: column; border: thin solid var(--border); border-radius: var(--radius-md, 0.375rem); background: var(--card); max-height: ${SPACE(48)}; overflow-y: auto; }
.br-mention-option { display: flex; align-items: baseline; justify-content: space-between; gap: ${SPACE(3)}; padding: ${SPACE(2)} ${SPACE(3)}; cursor: pointer; }
.br-mention-option[data-active="true"], .br-mention-option:hover { background: var(--accent); }
.br-visually-hidden { position: absolute; width: ${SPACE(0.25)}; height: ${SPACE(0.25)}; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

export function BoardroomStyles() {
  return <style data-boardroom-styles="">{css}</style>;
}
