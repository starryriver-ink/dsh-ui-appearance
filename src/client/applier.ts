/**
 * DOM applier for appearance settings: owns one stylesheet and one fixed
 * background layer element. Forwards the active token overrides into
 * ctx.theme and exposes live CSS variables the stylesheet consumes. Every
 * write is retracted on dispose, so disabling the plugin restores the stock
 * UI exactly.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ctx.theme Context merge (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AppearanceSettings } from '../appearance-settings.ts'
import { DEFAULT_SETTINGS } from '../appearance-settings.ts'
import { buildTokenOverrides, bubbleInk, OVERRIDE_SOURCE } from './tokens.ts'
import { getImage } from './image-store.ts'
import { getVideo } from './video-store.ts'

/** Background layer element id (the stylesheet targets it). */
export const BG_LAYER_ID = 'dsw-appearance-bg'
/** Stylesheet element id owned by this plugin. */
export const STYLE_ID = 'dsw-appearance-styles'

/** CSS variables the applier writes on body, consumed by the stylesheet. */
const BODY_VARIABLES = [
  '--dsw-appearance-bg-image',
  '--dsw-appearance-bg-opacity',
  '--dsw-appearance-bg-base-light',
  '--dsw-appearance-bg-base-dark',
  '--dsw-appearance-filter',
  '--dsw-appearance-inset',
  '--dsw-appearance-scrim',
  '--dsw-appearance-bubble-ink-light',
  '--dsw-appearance-bubble-ink-dark',
  '--dsh-sidebar-row-h',
  '--dsh-sidebar-project-h',
  '--dsh-sidebar-files-pad',
  '--dsh-sidebar-indent-scale',
  '--dsh-sidebar-guide-color',
] as const

/**
 * Edge margin (px) the wallpaper layer grows by while a blur is active.
 *
 * A blurred layer bleeds partial transparency at its own edges unless it
 * extends past the viewport, so the sheet pushes the layer out by this much —
 * but only while a blur actually applies. With no blur the margin buys nothing
 * and costs a composite ~11% larger than the viewport plus a scaling pass over
 * the media on every presented frame.
 *
 * 48px covers the largest blur the sliders allow (30px background + 20px glass).
 */
const BLUR_EDGE_MARGIN_PX = 48

/**
 * Static sheet: the background layer is pushed to `z-index: -1` so it paints
 * below all content but above the body background — surfaces painted with
 * translucent tokens still show the image through, and no stacking context is
 * created on #root. The layer's `inset` is driven by `--dsw-appearance-inset`:
 * it grows past the viewport only while a blur applies, since hiding blur edge
 * bleed is the only reason that margin exists.
 *
 * #root is deliberately left untouched: no `position`/`z-index`, no
 * `backdrop-filter`. A non-none backdrop-filter turns #root into the
 * containing block of every fixed-position descendant (menus, tooltips,
 * toasts), and any `z-index` traps those descendants in a stacking context
 * scoped to #root — whose own effective z then sits at the page level. Either
 * would let top-level third-party panels (e.g. dsh-better-sidebar's
 * `position: fixed; z-index: 40` panel) paint over the DSH settings dialog
 * (`position: fixed; z-index: 1000`, a descendant of #root). Pushing the
 * wallpaper layer to -1 instead of lifting #root keeps fixed overlays at the
 * top level, so the dialog always wins. Blurring the wallpaper directly is
 * visually equivalent here — the only thing behind #root is this layer — and
 * leaves fixed positioning alone.
 *
 * Three-layer composition:
 * 1. Base canvas: holds the user's customized background color (or mode fallback).
 * 2. Media layer (::before / video): paints wallpaper with opacity and blur.
 *    Lowering opacity smoothly blends the media into the base canvas color.
 * 3. Scrim layer (::after): applies the uniform readability veil on top of media.
 */
const SHEET = `
#${BG_LAYER_ID} {
  position: fixed;
  inset: var(--dsw-appearance-inset, 0px);
  z-index: -1;
  pointer-events: none;
  background-color: var(--dsw-appearance-bg-base-light, #ffffff);
}
:is(html[data-ds-dark-theme], html[data-theme="dark"], body[data-ds-dark-theme], body[data-theme="dark"]) #${BG_LAYER_ID} {
  background-color: var(--dsw-appearance-bg-base-dark, #151517);
}
#${BG_LAYER_ID}::before {
  content: "";
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
  background-image: var(--dsw-appearance-bg-image, none);
  opacity: var(--dsw-appearance-bg-opacity, 1);
  filter: var(--dsw-appearance-filter, none);
}
#${BG_LAYER_ID}[data-video]::before {
  display: none;
}
#${BG_LAYER_ID} video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: none;
  opacity: var(--dsw-appearance-bg-opacity, 1);
  filter: var(--dsw-appearance-filter, none);
}
#${BG_LAYER_ID}[data-video] video {
  display: block;
}
#${BG_LAYER_ID}::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    rgba(255, 255, 255, var(--dsw-appearance-scrim, 0)) 0%,
    rgba(255, 255, 255, var(--dsw-appearance-scrim, 0)) 100%
  );
}
:is(html[data-ds-dark-theme], html[data-theme="dark"], body[data-ds-dark-theme], body[data-theme="dark"]) #${BG_LAYER_ID}::after {
  background: linear-gradient(
    rgba(8, 10, 18, var(--dsw-appearance-scrim, 0)) 0%,
    rgba(8, 10, 18, var(--dsw-appearance-scrim, 0)) 100%
  );
}
/* Windows desktop host frame punch-out (Issue #31):
   In DSH 0.2.0 desktop on Windows, [data-windows-titlebar] adds an opaque
   "background: var(--dsw-specific-sidebar-fill)" to the three-column outer frame
   (.BynINW_frame) and its titlebar drag strip (:before). Because this outer frame
   encloses the entire viewport, its opaque sidebar-fill completely covers the
   #dsw-appearance-bg layer, preventing the wallpaper from showing on the main
   chat area until surfaceAlpha reduces the sidebar fill's opacity.
   On macOS the host natively sets "[data-platform=darwin] .BynINW_frame { background: 0 0 }".
   When background media is active (data-dsw-has-bg), punch out the Windows frame
   and its drag strip to transparent so the wallpaper reveals through the main canvas,
   aligning Windows desktop behavior with Web and macOS. */
html[data-dsw-has-bg][data-windows-titlebar] [class*="_frame"],
html[data-dsw-has-bg] [data-windows-titlebar] [class*="_frame"] {
  background: transparent !important;
}
html[data-dsw-has-bg][data-windows-titlebar] [class*="_frame"]:before,
html[data-dsw-has-bg] [data-windows-titlebar] [class*="_frame"]:before {
  background: transparent !important;
}
#root ::selection {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
}
#root :focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
/* Freeze transitions during active slider / color-picker drags so rapid
   token updates (like input opacity applied to the send button) render at
   60fps without jitter. data-dsw-sliding is set by the row's drag handlers;
   the :active color-input rule is a belt-and-suspenders for the native
   picker keeping focus without pointer events. */
body:has(input[type="range"]:active) *,
body:has(input[type="color"]:active) *,
body[data-dsw-sliding] * {
  transition-duration: 0s !important;
}
/* Accent auto-inversion: the user bubble paints its background with
   --dsw-specific-bubble (= accent) but its text with the GLOBAL
   --dsw-alias-label-primary (there is no bubble foreground token), so a dark
   accent + dark text is unreadable. Scope the text variable to the bubble
   subtree only — CSS custom properties inherit through its DOM, so markdown
   and links referencing the token follow too — and gate it on a body
   attribute the applier sets per mode, so turning the toggle off / disabling
   the plugin restores the stock color exactly. The hashed class prefix
   (Sixlwa_) changes across host builds; the stable local name is 'bubble'. */
/* User-message bubble legibility (Issue #27): the user bubble background is
   painted with --dsw-specific-bubble (= accent), while inline file/skill/session
   reference chips (.refChip in user-text.module.css) use
   color: var(--dsw-alias-state-business-primary) (= also accent). Without
   scoping, accent text on an accent bubble has a 1:1 contrast ratio and
   becomes invisible regardless of whether accent auto-inversion is on.
   Pointing the business/brand foreground tokens at --dsw-alias-label-primary
   inside the bubble ensures reference chips always inherit the bubble's
   readable foreground ink (either the user's text role or the auto-inverted
   bubble ink below), while a subtle translucent pill + underline preserves
   chip distinction. */
#root [class*="_bubble"],
#root [class*="bubble" i] {
  --dsw-alias-state-business-primary: var(--dsw-alias-label-primary);
  --dsw-alias-brand-primary: var(--dsw-alias-label-primary);
}
#root [class*="_bubble"] [class*="refChip"],
#root [class*="bubble" i] [class*="refChip"] {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
  padding: 1px 6px;
  border-radius: 6px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
body[data-dsw-bubble-ink-light] #root [class*="_bubble"],
body[data-dsw-bubble-ink-light] #root [class*="bubble" i] {
  --dsw-alias-label-primary: var(--dsw-appearance-bubble-ink-light);
  --dsw-alias-label-secondary: var(--dsw-appearance-bubble-ink-light);
  --dsw-alias-state-business-primary: var(--dsw-appearance-bubble-ink-light);
  --dsw-alias-brand-primary: var(--dsw-appearance-bubble-ink-light);
}
body[data-dsw-bubble-ink-light] #root [class*="_bubble"] a,
body[data-dsw-bubble-ink-light] #root [class*="bubble" i] a {
  color: inherit;
  text-decoration: underline;
}
:is(html[data-ds-dark-theme], html[data-theme="dark"]) body[data-dsw-bubble-ink-dark] #root [class*="_bubble"],
:is(html[data-ds-dark-theme], html[data-theme="dark"]) body[data-dsw-bubble-ink-dark] #root [class*="bubble" i],
:is(body[data-ds-dark-theme], body[data-theme="dark"])[data-dsw-bubble-ink-dark] #root [class*="_bubble"],
:is(body[data-ds-dark-theme], body[data-theme="dark"])[data-dsw-bubble-ink-dark] #root [class*="bubble" i] {
  --dsw-alias-label-primary: var(--dsw-appearance-bubble-ink-dark);
  --dsw-alias-label-secondary: var(--dsw-appearance-bubble-ink-dark);
  --dsw-alias-state-business-primary: var(--dsw-appearance-bubble-ink-dark);
  --dsw-alias-brand-primary: var(--dsw-appearance-bubble-ink-dark);
}
:is(html[data-ds-dark-theme], html[data-theme="dark"]) body[data-dsw-bubble-ink-dark] #root [class*="_bubble"] a,
:is(html[data-ds-dark-theme], html[data-theme="dark"]) body[data-dsw-bubble-ink-dark] #root [class*="bubble" i] a,
:is(body[data-dsw-bubble-ink-dark], html[data-ds-dark-theme] body[data-dsw-bubble-ink-dark], html[data-theme="dark"] body[data-dsw-bubble-ink-dark]) #root [class*="bubble" i] a {
  color: inherit;
  text-decoration: underline;
}
/* Solid tags legibility (Issue: Agent Presets "新任务默认"):
   DSH's stock Tag component pairs background: var(--dsw-alias-label-primary)
   with color: var(--dsw-alias-bg-layer-3). Because bg-layer-3 is a surface
   token that becomes translucent when surfaceAlpha < 1 (and completely
   transparent at surfaceAlpha: 0), the text in solid tags becomes invisible
   against the opaque label-primary pill. Enforce the high-contrast inverted
   label ink on all solid tags. */
:is(#root, body) [data-tone='solid'] {
  color: var(--dsw-alias-label-primary-inverted) !important;
}
/* Deliverables & changed-files cards (translucency support):
   DSH hardcodes --changes-fill / --deliverable-fill to static opaque neutrals
   (--dsw-static-neutral-50/850), making the "已修改 X 个文件" header and file
   chips remain opaque blocks when translucent panels are active.
   Remap them to alias module/hover tokens so they follow surfaceAlpha. */
:is(html, body) :is([class*="card" i], [class*="root" i], [class*="file" i], [class*="header" i], [class*="deliverable" i], [class*="changes" i]),
:is(html, body) [class*="kuvljq"],
:is(html, body) [class*="flL80G"] {
  --changes-fill: var(--dsw-alias-bg-module-platform) !important;
  --changes-hover: var(--dsw-alias-interactive-bg-hover-solid) !important;
  --deliverable-fill: var(--dsw-alias-bg-module-platform) !important;
  --deliverable-hover: var(--dsw-alias-interactive-bg-hover-solid) !important;
}
/* Menu & popover surfaces (MenuSurface, jobs panel, permission presets, avatar menu):
   DSH MenuSurface sets background: var(--dsw-menu-surface-fill) and
   backdrop-filter: var(--dsw-menu-backdrop-filter). Guarantee that menu surfaces
   always evaluate to the user's translucent menu tokens and follow glassBlur. */
[data-menu-material],
:is(#root, body) [data-menu-material],
:is(#root, body) [class*="menu" i] {
  --dsw-menu-surface-fill: var(--dsw-specific-menu) !important;
}
/* ---- Sidebar / explorer tuning -------------------------------------------------
   Selectors match the host's CSS-module *local* names (rendered as "<hash>_<local>")
   and its data attributes, so a host rebuild that keeps the names keeps working;
   a rename degrades to "no styling", never to a broken layout. */
/* Row height: session rows take the slider value, project rows sit 4px taller. */
[class*="_sessionRow"] {
  height: var(--dsh-sidebar-row-h, 32px) !important;
}
[class*="_projectRow"] {
  height: var(--dsh-sidebar-project-h, 34px) !important;
}
/* Indent: the host writes --dsh-workspace-indent inline (depth * 12px) and consumes it
   through this padding, so the scale has to be applied here rather than to the variable.
   Measured on 0.2.1: that variable only ever takes 0px (workspace rows) and 12px (their
   children), so it cannot express deeper levels; sessions share their project's 12px and
   therefore never indent past it. Sessions get one extra step below. */
[class*="_projectRow"] {
  padding-inline-start: calc(8px + var(--dsh-workspace-indent, 0px) * var(--dsh-sidebar-indent-scale, 1)) !important;
}
[class*="_sessionRow"] {
  padding-inline-start: calc(8px + (var(--dsh-workspace-indent, 0px) + 12px) * var(--dsh-sidebar-indent-scale, 1)) !important;
}
/* Hover used to hide the folder icon and reveal the chevron. Both slots are 16px wide,
   so revealing one and hiding the other re-flowed the row — the hover jitter. Keeping
   both visible leaves the layout constant and keeps the expand affordance.
   The row itself toggles on click and the folder icon already encodes open/closed. */
[class*="_projectRow"] [class*="_chevron"] {
  display: inline-flex !important;
  /* Explorer order is arrow-then-folder, with the arrow in the indent column so it
     lines up with the guide rails; the host renders folder-then-chevron. */
  order: -1;
}
[class*="_projectRow"]:hover [class*="_folder"] {
  display: inline-flex !important;
}
/* Selection: the host tints session rows with the same colour it uses for hover, so the
   active session reads no differently from a hovered one. Paint the whole row with the
   accent instead. Project rows are deliberately NOT included: folderActive is set on every
   ancestor of the current session, so :has() on the icon lit up the whole ancestor chain. */
[class*="_sessionRow"][class*="_selected"],
[class*="_searchResultRow"][class*="_selected"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 20%, transparent) !important;
}
/* Indent guides: one 1px rail per row, in its PARENT's column, so the rails of
   consecutive rows at the same level join into a continuous line. Overflowing 4px past
   the row on both sides closes the gap between rows (row pitch > row height). The earlier
   gradient could not do either: it was clipped to the indent box, so its outer rail landed
   exactly on the box edge and got cut away, and each row only covered its own height. */
[class*="_sessionRow"],
[class*="_projectRow"] {
  position: relative;
}
[class*="_sessionRow"]::before,
[class*="_projectRow"]::before {
  content: "";
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 1px;
  pointer-events: none;
  background: var(--dsh-sidebar-guide-color, transparent);
}
/* Project rows: the centre of their workspace's icon/chevron column. At depth 0 this
   resolves negative and the rail falls outside the row, which is right for roots.
   The +8px centres the rail on the parent's icon, the way an explorer aligns its guides,
   instead of leaving it flush with the parent's padding edge. */
[class*="_projectRow"]::before {
  left: calc(16px + (var(--dsh-workspace-indent, 0px) - 12px) * var(--dsh-sidebar-indent-scale, 1));
}
/* Session rows: the centre of the icon/chevron column of the project that owns them. */
[class*="_sessionRow"]::before {
  left: calc(16px + var(--dsh-workspace-indent, 0px) * var(--dsh-sidebar-indent-scale, 1));
}
/* Files ("work tree") panel: denser rows and the same guide idea, drawn as a rail on
   each nested level because that tree nests <ul> instead of using a depth variable. */
[data-files-root] [data-files-row] {
  padding-top: var(--dsh-sidebar-files-pad, 5px) !important;
  padding-bottom: var(--dsh-sidebar-files-pad, 5px) !important;
}
[data-files-root] [class*="_level"] {
  padding-left: 24px !important;
}
[data-files-root] [class*="_level"] [class*="_level"] {
  border-left: 1px solid var(--dsh-sidebar-guide-color, transparent);
}
/* Note: an earlier revision put a border on every nested group section. Each project is
   its own nested group, so that drew one short segment per project rather than a
   continuous rail; dropped in favour of the per-row rails above. */
/* The files tree has no selection state and no hover feedback of its own. Hover gets the
   standard tint; :focus makes the last-clicked row stay highlighted while it holds focus,
   which is the closest the host lets a stylesheet get to "current row" without inventing
   state the host would wipe on its next render. */
[data-files-root] [data-files-path] > button:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}
[data-files-root] [data-files-path] > button:focus {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 20%, transparent) !important;
}
`

/**
 * Projects one appearance settings snapshot onto the document. Replaces the
 * token override layer on every apply; retracts everything in dispose.
 */
export class AppearanceApplier {
  private readonly style: HTMLStyleElement
  private readonly layer: HTMLDivElement
  private videoEl: HTMLVideoElement | undefined
  private videoUrl: string | undefined
  private videoKey = ''
  private imageToken = ''
  private imageUrl: string | undefined
  private removeOverrides: (() => void) | undefined
  private videoFailed = false
  /** Last applied background-video playback rate; 1 until a snapshot says otherwise. */
  private videoRate = 1

  /**
   * Notified when the background video stops being playable (unsupported
   * codec, decode error) or becomes playable again. The row has no other way
   * to learn that an uploaded video never reached the screen, so it surfaces
   * this as a hint instead of leaving a silent, invisible background.
   */
  onVideoPlaybackError: ((failed: boolean) => void) | undefined

  /**
   * @param ctx - client context providing the theme service.
   */
  constructor(private readonly ctx: ClientContext) {
    this.style = document.createElement('style')
    this.style.id = STYLE_ID
    this.style.textContent = SHEET
    document.head.append(this.style)
    this.layer = document.createElement('div')
    this.layer.id = BG_LAYER_ID
    document.body.prepend(this.layer)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  /**
   * Apply a settings snapshot: rebuild the theme override layer and refresh
   * the body CSS variables. Undefined values (settings not yet loaded) apply
   * the stock defaults, which removes the override layer.
   * @param settings - current appearance settings or undefined while loading.
   */
  apply(settings: AppearanceSettings | undefined): void {
    const value = settings ?? DEFAULT_SETTINGS
    const oldRemove = this.removeOverrides
    const tokens = buildTokenOverrides(value)
    this.removeOverrides = Object.keys(tokens).length > 0
      ? this.ctx.theme.overrideTokens(OVERRIDE_SOURCE, tokens)
      : undefined
    oldRemove?.()
    const body = document.body
    // Windows desktop host frame punch-out (Issue #31):
    // DSH 0.2.0 desktop on Windows sets `[data-windows-titlebar] .BynINW_frame { background: var(--dsw-specific-sidebar-fill) }`
    // which encloses the entire viewport with opaque sidebar color, blocking the wallpaper on the main canvas.
    // Setting `data-dsw-has-bg` on <html> triggers the transparent frame rule when wallpaper/video is active,
    // aligning Windows desktop behavior with Web and macOS.
    const hasMedia = value.backgroundImage !== '' || value.backgroundVideo !== ''
    if (hasMedia) {
      document.documentElement.setAttribute('data-dsw-has-bg', '')
    } else {
      document.documentElement.removeAttribute('data-dsw-has-bg')
    }
    // The wallpaper rides a CSS variable like every other knob; the value is
    // a record key (or legacy inline data URL) and resolves asynchronously.
    void this.syncImage(value.backgroundImage)
    body.style.setProperty('--dsw-appearance-bg-opacity', String(value.backgroundOpacity))
    const defaultLightBase = value.imageDark ? '#151517' : '#ffffff'
    const bgLight = value.light?.background || value.background || defaultLightBase
    const bgDark = value.dark?.background || value.background || '#151517'
    body.style.setProperty('--dsw-appearance-bg-base-light', bgLight)
    body.style.setProperty('--dsw-appearance-bg-base-dark', bgDark)
    // 背景模糊 and 毛玻璃 ride the same wallpaper-layer filter: dragging either
    // slider deepens the blur of the wallpaper that the translucent surfaces
    // reveal. The panels themselves are never touched.
    //
    // The variable carries a whole filter value rather than a bare radius, so
    // that a zero radius resolves to `none` instead of `blur(0px)`. Any
    // non-none filter puts the wallpaper layer on the offscreen filter path,
    // which costs a full-viewport pass per presented frame — pure overhead at
    // radius 0, and the video layer is where it hurts most, because Chromium
    // can otherwise hand a plain <video> straight to the display engine.
    const wallpaperBlur = value.backgroundBlur + value.glassBlur
    body.style.setProperty(
      '--dsw-appearance-filter',
      wallpaperBlur > 0 ? `blur(${wallpaperBlur}px)` : 'none',
    )
    // The edge margin rides the same condition as the filter: growing the layer
    // past the viewport only hides blur edge bleed, so with no blur it is pure
    // overhead — a composite ~11% larger than the viewport plus a scaling pass
    // over the media every presented frame.
    body.style.setProperty(
      '--dsw-appearance-inset',
      wallpaperBlur > 0 ? `-${BLUR_EDGE_MARGIN_PX}px` : '0px',
    )
    // Sidebar / explorer tuning. Derived values keep a single row-height knob
    // meaningful: project rows stay 4px taller than session rows, and the files
    // tree's row padding grows half as fast as the row height.
    const rowHeight = Math.round(value.sidebarRowHeight)
    body.style.setProperty('--dsh-sidebar-row-h', `${rowHeight}px`)
    body.style.setProperty('--dsh-sidebar-project-h', `${rowHeight + 4}px`)
    body.style.setProperty('--dsh-sidebar-files-pad', `${Math.max(2, Math.round(5 + (rowHeight - 32) / 2))}px`)
    body.style.setProperty('--dsh-sidebar-indent-scale', String(value.sidebarIndentScale))
    body.style.setProperty(
      '--dsh-sidebar-guide-color',
      value.sidebarGuides === false
        ? 'transparent'
        : 'color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b8b8b) 45%, transparent)',
    )
    // 毛玻璃 also drives the host's modal masks and dropdown menu backdrop filters:
    // dialogs/dropdowns dim the page through `.mask` elements whose backdrop-filter
    // is `var(--dsw-mask-blur)` (stock: blur(2px)), and MenuSurface / JobListAction blur
    // underlying content through `var(--dsw-menu-backdrop-filter)` (stock: blur(40px)).
    // Writing both tokens on body wins over the host's stylesheet definitions (body is
    // the closer ancestor), so all popovers and masks frost synchronously with the slider.
    // 0 means a cleared mask, NOT the stock fallbacks — write an explicit
    // `none` so a no-op radius does not keep the mask on the filter path.
    body.style.setProperty(
      '--dsw-mask-blur',
      value.glassBlur > 0 ? `blur(${value.glassBlur}px)` : 'none',
    )
    body.style.setProperty(
      '--dsw-menu-backdrop-filter',
      value.glassBlur > 0 ? `blur(${value.glassBlur}px) saturate(150%)` : 'none',
    )
    body.style.setProperty('--dsw-appearance-scrim', String(value.scrim))
    // Accent auto-inversion: scope the bubble text token to a contrast ink.
    // The stylesheet rules only match while the per-mode gate attribute is
    // present, so a null ink (toggle off) retracts the override entirely.
    const ink = bubbleInk(value)
    this.applyBubbleInk('light', ink.light)
    this.applyBubbleInk('dark', ink.dark)
    // Playback rate: record it and push it onto the live element right here,
    // because syncVideo() early-returns while the record key is unchanged — a
    // rate change on the already-loaded video would never reach it.
    this.videoRate = value.backgroundVideoRate > 0 ? value.backgroundVideoRate : 1
    this.syncPlaybackRate()
    // A background video (IndexedDB record key) replaces the image layer;
    // loading is async and only re-runs when the key changes.
    void this.syncVideo(value.backgroundVideo)
  }

  /**
   * Set or retract the per-mode bubble text ink. Writes a body custom
   * property with the color and a gate attribute that arms the scoped
   * stylesheet rule.
   * @param mode - theme mode the ink is computed for.
   * @param hex - contrast ink color, or null to retract the override.
   */
  private applyBubbleInk(mode: 'light' | 'dark', hex: string | null): void {
    const body = document.body
    const attr = `data-dsw-bubble-ink-${mode}`
    const variable = `--dsw-appearance-bubble-ink-${mode}`
    if (hex === null) {
      body.removeAttribute(attr)
      body.style.removeProperty(variable)
    } else {
      body.setAttribute(attr, '')
      body.style.setProperty(variable, hex)
    }
  }

  /**
   * Load or clear the wallpaper for a background token. Legacy records still
   * carry an inline data URL (applied directly); current records hold an
   * IndexedDB key resolved through an object URL. Reuses the object URL when
   * the token is unchanged, so repeated applies never re-read IndexedDB.
   * @param token - record key, legacy data URL, or '' to clear.
   */
  private async syncImage(token: string): Promise<void> {
    if (token === this.imageToken) return
    this.imageToken = token
    this.teardownImage()
    const body = document.body
    if (token === '') {
      body.style.setProperty('--dsw-appearance-bg-image', 'none')
      return
    }
    if (token.startsWith('data:')) {
      body.style.setProperty('--dsw-appearance-bg-image', `url("${token}")`)
      return
    }
    const blob = await getImage(token)
    if (this.imageToken !== token) {
      // Superseded by a newer apply; the newer syncImage owns the variable.
      return
    }
    if (blob === undefined) {
      // Deleted while loading: fall back to no wallpaper.
      this.imageToken = ''
      body.style.setProperty('--dsw-appearance-bg-image', 'none')
      return
    }
    this.imageUrl = URL.createObjectURL(blob)
    body.style.setProperty('--dsw-appearance-bg-image', `url("${this.imageUrl}")`)
  }

  /** Revoke the wallpaper object URL, if any. */
  private teardownImage(): void {
    if (this.imageUrl !== undefined) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = undefined
    }
  }

  /**
   * Load or clear the background video for a record key. Reuses the element
   * and object URL when the key is unchanged, so repeated applies never
   * re-read IndexedDB.
   * @param key - video record key, or '' to clear.
   */
  private async syncVideo(key: string): Promise<void> {
    if (key === '') {
      this.videoKey = ''
      this.teardownVideo()
      this.layer.removeAttribute('data-video')
      this.reportVideoError(false)
      return
    }
    if (key === this.videoKey) return
    this.videoKey = key
    this.teardownVideo()
    const record = await getVideo(key)
    if (record === undefined || this.videoKey !== key) {
      // Deleted while loading, or superseded by a newer apply.
      this.videoKey = ''
      this.layer.removeAttribute('data-video')
      this.reportVideoError(false)
      return
    }
    const video = this.ensureVideo()
    this.videoUrl = URL.createObjectURL(record)
    video.src = this.videoUrl
    // Assigning `src` runs the media load algorithm, which resets playbackRate
    // back to defaultPlaybackRate — so the configured rate has to be re-applied
    // after it. Without this a freshly loaded wallpaper silently played at 1x
    // until the user nudged the speed slider (whose path does not go through a
    // load), which is exactly how the persisted rate "did not take effect".
    this.syncPlaybackRate()
    // Unsupported codec (e.g. HEVC in an mp4): drop the video layer so the
    // wallpaper fallback (if any) shows instead of a black frame, and tell the
    // row — otherwise the failure is indistinguishable from "no background".
    video.onerror = (): void => {
      this.videoKey = ''
      this.layer.removeAttribute('data-video')
      this.teardownVideo()
      this.reportVideoError(true)
    }
    // Decoding started: the codec is supported after all (a swapped-in video
    // may recover from a previous failure).
    video.onloadeddata = (): void => { this.reportVideoError(false) }
    this.layer.setAttribute('data-video', '')
    // Starts, or stays paused, according to document visibility: loading a
    // wallpaper while the window is hidden must not spin up the decoder.
    this.syncPlaybackState()
  }

  /**
   * Report a change in the background video's playability, at most once per
   * state so a settings re-apply cannot spam the row's store.
   * @param failed - whether the video is currently unplayable.
   */
  private reportVideoError(failed: boolean): void {
    if (this.videoFailed === failed) return
    this.videoFailed = failed
    this.onVideoPlaybackError?.(failed)
  }

  /**
   * Pause the background video while the document is hidden and resume it when
   * the page comes back. A wallpaper is invisible then, but a playing video
   * still costs a whole hardware-decode pipeline — measured as by far the
   * largest GPU consumer this plugin has — so leaving it running in a
   * background window is pure waste.
   */
  private readonly onVisibilityChange = (): void => {
    this.syncPlaybackState()
  }

  /**
   * Align the video element's playback with the document visibility. Called on
   * every visibility change and whenever a video is (re)loaded, so a wallpaper
   * that arrives while the window is hidden does not spin up the decoder.
   */
  private syncPlaybackState(): void {
    const video = this.videoEl
    if (video === undefined) return
    if (document.hidden) {
      video.pause()
      return
    }
    video.play().catch(() => {
      // Autoplay policy or unsupported codec: keep the layer fallback silent.
      // `onerror` owns the unsupported-codec report; a play() rejection on its
      // own is not a decode failure and must not claim one.
    })
  }

  /**
   * Push the configured rate onto the video element.
   *
   * `defaultPlaybackRate` is written alongside `playbackRate` because the media
   * load algorithm (triggered by assigning `src`, and by `load()`) resets
   * `playbackRate` to `defaultPlaybackRate`. Setting only `playbackRate` before
   * a load therefore loses the setting the moment the video starts loading.
   * No-op until an element exists.
   */
  private syncPlaybackRate(): void {
    const video = this.videoEl
    if (video === undefined) return
    video.defaultPlaybackRate = this.videoRate
    video.playbackRate = this.videoRate
  }

  /** Create the background video element once. */
  private ensureVideo(): HTMLVideoElement {
    if (this.videoEl === undefined) {
      const video = document.createElement('video')
      video.muted = true
      video.loop = true
      video.playsInline = true
      video.autoplay = true
      // Inherit the rate the last apply() recorded, so an element created for a
      // newly loaded video starts at the configured speed instead of 1x.
      video.defaultPlaybackRate = this.videoRate
      video.playbackRate = this.videoRate
      this.layer.append(video)
      this.videoEl = video
    }
    return this.videoEl
  }

  /** Remove the video element and revoke its object URL. */
  private teardownVideo(): void {
    this.videoEl?.remove()
    this.videoEl = undefined
    if (this.videoUrl !== undefined) {
      URL.revokeObjectURL(this.videoUrl)
      this.videoUrl = undefined
    }
  }

  /** Retract the override layer, the stylesheet, the layer element, and body variables. */
  dispose(): void {
    this.removeOverrides?.()
    this.removeOverrides = undefined
    // Drop the keys BEFORE tearing down: a getVideo()/getImage() still in
    // flight resolves after dispose, and the key comparison is what stops it
    // from recreating media on the removed layer.
    this.videoKey = ''
    this.teardownVideo()
    this.imageToken = ''
    this.teardownImage()
    this.style.remove()
    this.layer.remove()
    const body = document.body
    for (const name of BODY_VARIABLES) body.style.removeProperty(name)
    body.style.removeProperty('--dsw-mask-blur')
    body.style.removeProperty('--dsw-menu-backdrop-filter')
    body.removeAttribute('data-dsw-bubble-ink-light')
    body.removeAttribute('data-dsw-bubble-ink-dark')
    body.removeAttribute('data-dsw-sliding')
    // Compositor anchor cleanup: remove the html attribute so the host's natural
    // background resumes after the plugin is unloaded.
    document.documentElement.removeAttribute('data-dsw-has-bg')
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
  }
}
