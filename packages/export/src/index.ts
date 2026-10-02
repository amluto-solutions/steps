// Everything exported is built from one render model (docs/spec/05-export.md).
export * from "./model";
export * from "./geometry";
export { optimiseForSharing, renderStepImage } from "./render-image";
export { CAMERA_MARGIN, cameraFrame, cameraOf, withCameraFrame, type CameraBox } from "./camera";
export { pdfDefinition, renderPdf, richTextToPdf, type PdfFonts, type PdfOptions } from "./pdf";
export { imageSize, renderDocx, richTextToDocx } from "./docx";
export { escapeHtml, renderClipboardHtml, renderClipboardText, richTextToHtml } from "./html";
export {
  overlaySvg,
  renderWalkthrough,
  WALKTHROUGH_LABELS,
  type WalkthroughFonts,
} from "./walkthrough/render";
export { MOTION } from "./walkthrough/motion";
