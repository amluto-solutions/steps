import { AMLUTO_COLOURS, MARK_COLOUR_HEX, type CalloutKind } from "@amluto-steps/core";

import { safeFontName } from "../model";
import { CALLOUT_LOOK, calloutIconSvg, CODE_FONTS, EXPORT_PALETTE } from "../words";
import { motionProperties } from "./motion";

/** A colour as CSS, or the fallback: brand colours come from files and end up inside a stylesheet. */
export const safeColour = (value: string, fallback: string) =>
  /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) ? value : fallback;

// The pointer drawn over the screenshot (its tip is the element's top-left corner).
const POINTER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 2l15 11.5-6.6.9 3.8 7.4-2.6 1.3-3.8-7.4L3.9 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  );

export function walkthroughCss(
  colours: {
    primary: string;
    accent: string;
    highlight: string;
    headingFont?: string;
    bodyFont?: string;
  },
  fontFaces: string,
): string {
  // Brand fonts are named, never embedded; the bundled Jost and Inter follow them.
  const heading = safeFontName(colours.headingFont ?? "", "Century Gothic");
  const body = safeFontName(colours.bodyFont ?? "", "Aptos");
  const primary = safeColour(colours.primary, AMLUTO_COLOURS.primary);
  const accent = safeColour(colours.accent, AMLUTO_COLOURS.accent);
  const highlight = safeColour(colours.highlight, AMLUTO_COLOURS.highlight);
  return `${fontFaces}
:root{--wt-primary:${primary};--wt-accent:${accent};--wt-highlight:${highlight};--wt-ink:#1B2533;--wt-muted:${EXPORT_PALETTE.muted};--wt-line:${EXPORT_PALETTE.line};--wt-bg:#F5F7FA;--wt-card:#FFFFFF;
--wt-heading-font:"${heading}","Jost","Segoe UI",sans-serif;--wt-body-font:"${body}","Inter","Segoe UI",system-ui,sans-serif;${motionProperties()}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--wt-bg);color:var(--wt-ink);font:16px/1.5 var(--wt-body-font)}
h1,h2,h3,h4{font-family:var(--wt-heading-font);color:var(--wt-primary);line-height:1.25;margin:0 0 .5em}
a{color:var(--wt-accent)}
[hidden]{display:none!important}
:focus-visible{outline:3px solid var(--wt-accent);outline-offset:2px}
.wt-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wt-button{font:inherit;font-size:14px;font-weight:600;color:var(--wt-primary);background:#fff;border:1px solid var(--wt-line);border-radius:8px;padding:7px 14px;cursor:pointer;min-height:36px}
.wt-button:hover{border-color:var(--wt-accent)}
.wt-button[aria-pressed="true"]{background:var(--wt-primary);color:#fff;border-color:var(--wt-primary)}
.wt-button:disabled{opacity:.45;cursor:default}
.wt-primary{background:var(--wt-primary);color:#fff;border-color:var(--wt-primary)}
.wt-select{font:inherit;font-size:14px;border:1px solid var(--wt-line);border-radius:8px;padding:6px 8px;background:#fff;color:var(--wt-ink);min-height:36px}
.wt-notes>:first-child{margin-top:0}.wt-notes>:last-child{margin-bottom:0}
.wt-number{display:inline-grid;place-items:center;flex:none;width:34px;height:34px;border-radius:50%;background:var(--wt-primary);color:#fff;font:700 15px var(--wt-heading-font)}
.wt-logo{height:32px;width:auto;display:block}

/* ----- The player ----- */
/* Exactly one screen: the screenshot takes the room the header, strip and footer leave, and a
   long step scrolls inside its card, so the page itself never scrolls. */
.wt-player{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto auto;height:100vh;height:100dvh;overflow:hidden}
.wt-header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 20px;background:#fff;border-bottom:1px solid var(--wt-line)}
.wt-title{margin:0;font:700 17px var(--wt-heading-font);color:var(--wt-primary);flex:1;min-width:10em}
.wt-tools{display:flex;gap:8px;flex-wrap:wrap}
.wt-main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px;padding:20px;min-height:0;align-items:center;overflow:hidden}
.wt-no-image .wt-main{grid-template-columns:minmax(0,1fr)}
.wt-no-image .wt-stage{display:none}
.wt-no-image .wt-card{max-width:680px;justify-self:center;width:100%}
.wt-stage{display:grid;place-items:center;min-width:0;min-height:0;align-self:stretch;container-type:size;touch-action:pan-y}
.wt-frame{position:relative;container-type:inline-size;width:min(100%,calc((100dvh - 280px) * var(--wt-ratio,1.6)));width:min(100cqw,calc(100cqh * var(--wt-ratio,1.6)));border-radius:10px;overflow:hidden;box-shadow:0 6px 24px rgba(14,37,66,.14);background:#fff}
.wt-image{display:block;width:100%;height:100%;object-fit:contain}
.wt-camera{position:absolute;inset:0;transform-origin:0 0}
.wt-camera.wt-moving{transition:transform var(--wt-camera) var(--wt-camera-ease) var(--wt-camera-delay)}
.wt-marks,.wt-marks svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.wt-cursor{position:absolute;width:24px;height:24px;background:url("${POINTER}") no-repeat;background-size:contain;opacity:0;pointer-events:none;transform-origin:3px 2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.wt-cursor.wt-visible{opacity:1}
.wt-cursor.wt-visible:not(.wt-glide){animation:wt-appear var(--wt-fade) ease-out both}
.wt-cursor.wt-glide{transition:left var(--wt-glide) var(--wt-glide-ease),top var(--wt-glide) var(--wt-glide-ease)}
.wt-cursor.wt-press{animation:wt-press var(--wt-press) ease-out var(--wt-press-delay) both}
.wt-cursor.wt-visible.wt-press:not(.wt-glide){animation:wt-appear var(--wt-fade) ease-out both,wt-press var(--wt-press) ease-out var(--wt-press-delay) both}
.wt-ripple{position:absolute;width:56px;height:56px;margin:-28px 0 0 -28px;border:3px solid var(--wt-highlight);border-radius:50%;opacity:0;pointer-events:none}
.wt-ripple.wt-rippling{animation:wt-ripple var(--wt-ripple) ease-out var(--wt-press-delay) both}
.wt-fade{animation:wt-appear var(--wt-fade) ease-out both}
.wt-draw .wt-highlight{stroke-dasharray:100;stroke-dashoffset:100;animation:wt-trace var(--wt-draw) ease-out var(--wt-draw-delay) forwards}
.wt-draw .wt-later{opacity:0;animation:wt-appear var(--wt-marks) ease-out var(--wt-marks-delay) forwards}
.wt-card{background:var(--wt-card);border:1px solid var(--wt-line);border-radius:12px;padding:22px;max-height:100%;overflow:auto;box-shadow:0 2px 10px rgba(14,37,66,.06)}
.wt-card.wt-enter{animation:wt-rise var(--wt-card) var(--wt-card-ease) both}
.wt-card-title{font-size:26px}
.wt-step-top{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
.wt-step-text{font:700 19px/1.35 var(--wt-body-font);color:var(--wt-ink);margin:4px 0 0}
.wt-motion{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 14px 46px}
.wt-field{display:inline-block;min-width:14ch;min-height:2.2em;padding:6px 10px;border:1px solid var(--wt-line);border-radius:6px;background:#fff;font:15px/1.4 Consolas,"Cascadia Mono",monospace;color:var(--wt-ink)}
.wt-typing{position:absolute;display:flex;overflow:hidden;color:#1b1f24;font-family:Consolas,"Cascadia Mono",monospace;line-height:1.3;animation:wt-appear var(--wt-marks) ease-out var(--wt-draw-delay) both}
.wt-typing-field{align-items:center;padding:0 .45em;background:#fff;border-radius:.25em;white-space:pre}
.wt-typing-card{display:block;margin:.6em;max-height:45%;padding:.45em .7em;background:#fff;border:1px solid var(--wt-line);border-radius:.5em;box-shadow:0 .3em 1em rgba(14,37,66,.18);white-space:pre-wrap;overflow-wrap:anywhere}
.wt-typing-at{margin:0 0 0 .3em;transform:translateY(-50%);white-space:pre;overflow-wrap:normal}
.wt-caret{display:inline-block;flex:none;align-self:center;vertical-align:text-bottom;width:0;height:1.15em;margin-left:1px;border-left:.09em solid currentColor;animation:wt-blink 1s steps(1) infinite}
.wt-reduce .wt-caret{animation:none}
.wt-key{display:inline-block;min-width:2.2em;padding:4px 9px;border:1px solid var(--wt-line);border-bottom-width:3px;border-radius:6px;background:#fff;font:600 14px var(--wt-body-font);color:var(--wt-primary);text-align:center;animation:wt-pop 220ms ease-out both}
.wt-plus{color:var(--wt-muted)}
.wt-pill{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 12px;border-radius:999px;background:var(--wt-bg);border:1px solid var(--wt-line);font-size:14px;color:var(--wt-primary);animation:wt-slide 320ms ease-out var(--wt-marks-delay) both}
.wt-card .wt-notes{background:var(--wt-bg);border-radius:8px;padding:12px 14px;color:var(--wt-ink)}
.wt-card .wt-meta,.wt-card .wt-desc{color:var(--wt-muted)}
.wt-card .wt-static-intro{margin-top:16px}
.wt-card .wt-static-intro h2{font-size:17px}
.wt-start{margin-top:18px}
.wt-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.wt-block .wt-notes{background:none;padding:0}
.wt-chapter .wt-card{text-align:center;padding:48px 28px}
.wt-chapter .wt-card-title{font-size:32px}
.wt-strip{display:flex;gap:8px;overflow-x:auto;padding:10px 20px;background:#fff;border-top:1px solid var(--wt-line)}
.wt-thumb{position:relative;flex:none;width:128px;padding:0;border:2px solid transparent;border-radius:8px;background:none;cursor:pointer}
.wt-thumb img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:6px;background:var(--wt-bg)}
.wt-thumb.wt-active{border-color:var(--wt-primary)}
.wt-thumb-number{position:absolute;left:4px;top:4px;min-width:22px;padding:1px 6px;border-radius:999px;background:var(--wt-primary);color:#fff;font:700 12px var(--wt-body-font)}
.wt-footer{display:flex;align-items:center;gap:16px;padding:12px 20px;background:#fff;border-top:1px solid var(--wt-line)}
.wt-progress{flex:1;display:grid;gap:8px;min-width:0}
.wt-bar-row{display:flex;align-items:center;gap:10px}
.wt-bar{flex:1;height:4px;border-radius:2px;background:var(--wt-line);overflow:hidden}
.wt-percent{font-size:12px;font-variant-numeric:tabular-nums;color:var(--wt-muted);min-width:5.5em;text-align:right}
.wt-countdown{height:2px;border-radius:1px;background:var(--wt-line);overflow:hidden}
.wt-countdown[hidden]{display:none}
.wt-countdown-fill{height:100%;width:0;background:var(--wt-accent)}
.wt-fill{height:100%;width:0;background:var(--wt-primary);transition:width .3s ease-out}
.wt-dots{display:flex;flex-wrap:wrap;gap:4px;justify-content:center}
.wt-dot{width:24px;height:24px;padding:0;border:0;background:none;cursor:pointer;display:grid;place-items:center}
.wt-dot::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--wt-line)}
.wt-dot.wt-active::before{background:var(--wt-primary);transform:scale(1.35)}
.wt-reduce *,.wt-reduce *::before{animation:none!important;transition:none!important}
@media (max-width:800px){
.wt-main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,auto) minmax(0,1fr);align-items:start;gap:12px;padding:12px}
.wt-stage{align-self:auto;container-type:inline-size}
.wt-frame{width:min(100%,calc(45dvh * var(--wt-ratio,1.6)))}
.wt-card{padding:16px}
/* The dots in the footer move between steps; the thumbnails would take a third of a phone. */
.wt-strip{display:none}
.wt-header,.wt-footer{padding:8px 12px}
/* One row of tools that scrolls sideways, so the step keeps the room. */
.wt-header{gap:8px}
.wt-title{font-size:15px}
.wt-tools{flex:1 1 100%;min-width:0;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
.wt-tools .wt-button,.wt-tools .wt-select{flex:none;font-size:13px;min-height:32px;padding:5px 10px}
}
@media (prefers-reduced-motion:reduce){*,*::before{animation-duration:1ms!important;animation-delay:0s!important;transition:none!important}}
@keyframes wt-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes wt-slide{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
@keyframes wt-appear{from{opacity:0}to{opacity:1}}
@keyframes wt-blink{50%{opacity:0}}
@keyframes wt-trace{to{stroke-dashoffset:0}}
@keyframes wt-press{0%{transform:scale(1)}50%{transform:scale(.9)}100%{transform:scale(1)}}
@keyframes wt-ripple{0%{opacity:.9;transform:scale(.2)}100%{opacity:0;transform:scale(2.2)}}
@keyframes wt-rise{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}

/* ----- All steps (also the view without JavaScript, and what prints) ----- */
.wt-static{max-width:880px;margin:0 auto;padding:28px 20px 48px}
.wt-back-to-player{margin-bottom:16px}
.wt-static-head{margin-bottom:24px}
.wt-static-head .wt-logo{margin-bottom:16px}
.wt-static-head h1{font-size:30px}
.wt-desc{margin:0 0 6px}
.wt-meta{color:var(--wt-muted);font-size:14px;margin:0}
.wt-static-intro,.wt-static-outro{background:#fff;border:1px solid var(--wt-line);border-radius:12px;padding:18px 20px;margin:0 0 20px}
.wt-steps{list-style:none;margin:0;padding:0;display:grid;gap:18px}
.wt-static-step,.wt-static-block{background:#fff;border:1px solid var(--wt-line);border-radius:12px;padding:18px 20px;break-inside:avoid}
.wt-static-step .wt-step-top{margin-bottom:12px}
.wt-figure{position:relative;margin:0 0 12px}
.wt-shot{display:block;width:100%;height:auto;border:1px solid var(--wt-line);border-radius:8px}
.wt-figure .wt-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.wt-static-step .wt-notes{background:var(--wt-bg);border-radius:8px;padding:10px 14px}
.wt-static-block.wt-block-header{background:none;border:0;padding:12px 0 0}
.wt-callout{border-left:4px solid var(--wt-line);border-radius:6px;padding:8px 12px;margin:10px 0}
.wt-callout p{margin:4px 0}
.wt-block.wt-callout,.wt-static-block.wt-callout{border-left-width:6px;margin:0}
.wt-callout-label,.wt-block.wt-callout>.wt-card-title,.wt-static-block.wt-callout>h3{display:flex;align-items:center;gap:6px;color:var(--wt-callout-ink)}
.wt-callout-label::before,.wt-block.wt-callout>.wt-card-title::before,.wt-static-block.wt-callout>h3::before{content:"";flex:none;width:1.05em;height:1.05em;background:currentColor;-webkit-mask:var(--wt-callout-icon) center/contain no-repeat;mask:var(--wt-callout-icon) center/contain no-repeat}
${(Object.keys(CALLOUT_LOOK) as CalloutKind[])
  .map(
    (kind) =>
      `.wt-callout-${kind}{--wt-callout-ink:${CALLOUT_LOOK[kind].ink};--wt-callout-icon:url("data:image/svg+xml,${encodeURIComponent(calloutIconSvg(kind, "#000"))}")}`,
  )
  .join("\n")}
${Object.entries(CALLOUT_LOOK)
  .map(
    ([kind, look]) =>
      `.wt-callout.wt-callout-${kind}{border-left-color:${look.bar};background:${look.fill}}`,
  )
  .join("\n")}
.wt-made{color:${EXPORT_PALETTE.faint};font-size:13px;text-align:center;margin-top:28px}
.wt-made a{color:inherit}
.wt-overlay .wt-highlight{fill:none;stroke:var(--wt-highlight)}
.wt-overlay .wt-box{fill:none;stroke:var(--wt-mark,var(--wt-accent))}
.wt-overlay .wt-arrow line{stroke:var(--wt-mark,var(--wt-accent));stroke-linecap:round}
.wt-overlay .wt-arrow polygon{fill:var(--wt-mark,var(--wt-accent))}
.wt-overlay .wt-label rect{fill:#fff;stroke:var(--wt-mark,var(--wt-accent))}
${Object.entries(MARK_COLOUR_HEX)
  .map(([name, hex]) => `.wt-overlay .wt-c-${name}{--wt-mark:${hex}}`)
  .join("\n")}
.wt-overlay .wt-label.wt-c-white rect{fill:${MARK_COLOUR_HEX.black}}
.wt-overlay .wt-label.wt-c-white text{fill:#fff}
.wt-overlay .wt-label text{fill:var(--wt-primary);font-family:var(--wt-body-font);font-weight:600;dominant-baseline:central}
.wt-code{background:${EXPORT_PALETTE.codeBackground};border-radius:10px;overflow:hidden;margin:0 0 12px}
.wt-code-head{display:flex;align-items:center;gap:10px;min-height:38px;padding:0 8px 0 14px;background:${EXPORT_PALETTE.codeHeader};color:${EXPORT_PALETTE.codeLabel};font-size:12px}
.wt-code-label{font-weight:700;letter-spacing:.04em;text-transform:uppercase;flex:1}
.wt-code-head:not(:has(.wt-code-label)){justify-content:flex-end}
.wt-copy{font:700 12px/1 var(--wt-body-font);height:28px;padding:0 12px;border:0;border-radius:6px;background:${EXPORT_PALETTE.codeCopy};color:${EXPORT_PALETTE.codeBackground};cursor:pointer}
.wt-copy:focus-visible{outline:3px solid ${EXPORT_PALETTE.codeInk};outline-offset:2px}
.wt-code-text,.wt-output-text{margin:0;font:14px/1.6 ${CODE_FONTS};white-space:pre;overflow-x:auto}
.wt-code-text{padding:14px 18px;color:${EXPORT_PALETTE.codeInk}}
.wt-output{position:relative;border:1px solid var(--wt-line);border-radius:10px;background:var(--wt-card);padding:0 14px;margin:0 0 14px}
.wt-output summary{min-height:44px;display:flex;align-items:center;gap:8px;padding-right:72px;font-weight:600;cursor:pointer;list-style:none}
.wt-output summary::-webkit-details-marker{display:none}
.wt-output summary::before{content:"";width:7px;height:7px;border:solid var(--wt-muted);border-width:0 2px 2px 0;transform:rotate(-45deg);margin:0 4px 0 2px;transition:transform .15s}
.wt-output details[open] summary::before{transform:rotate(45deg)}
@media (prefers-reduced-motion:reduce){.wt-output summary::before{transition:none}}
.wt-output-count{font-weight:400;color:var(--wt-muted)}
.wt-output .wt-copy{position:absolute;top:8px;right:8px;background:none;color:var(--wt-accent);padding:0 10px}
.wt-output-text{font-size:13px;color:var(--wt-ink);padding:0 0 14px}
@media print{
body{background:#fff}
.wt-player{display:none!important}
.wt-static[hidden]{display:block!important}
.wt-back-to-player{display:none}
.wt-static-step,.wt-static-block,.wt-static-intro,.wt-static-outro{border-color:#ccc}
.wt-code{background:${EXPORT_PALETTE.codePaper};border:1px solid ${EXPORT_PALETTE.codeRule}}
.wt-code-head{background:none;color:var(--wt-muted);border-bottom:1px solid ${EXPORT_PALETTE.codeRule}}
.wt-code-text{color:var(--wt-ink)}
.wt-copy{display:none}
.wt-code-text,.wt-output-text{white-space:pre-wrap}
}`;
}
