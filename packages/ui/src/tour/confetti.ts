/**
 * A short burst of confetti in the brand colours when the tour is finished, drawn on a canvas over
 * everything that never takes the pointer and removes itself. Nothing at all with reduced motion.
 */
/** The brand tokens the pieces are cut from (packages/ui/src/styles.css). */
const TOKENS = [
  "--amluto-brand-navy",
  "--amluto-blue",
  "--amluto-cyan",
  "--amluto-highlight",
  "--amluto-bar-paused",
];
const DURATION_MS = 3200;

export function confetti() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: "none",
    zIndex: "1100",
  });
  document.body.append(canvas);
  context.scale(ratio, ratio);
  const style = getComputedStyle(document.documentElement);
  const colours = TOKENS.map((token) => style.getPropertyValue(token).trim()).filter(Boolean);

  // Two bursts from the lower corners, thrown up and inwards.
  const pieces = Array.from({ length: 160 }, (_, index) => {
    const fromLeft = index % 2 === 0;
    const angle = (fromLeft ? -60 : -120) + (Math.random() - 0.5) * 50;
    const speed = 9 + Math.random() * 9;
    return {
      x: fromLeft ? width * 0.1 : width * 0.9,
      y: height,
      vx: Math.cos((angle * Math.PI) / 180) * speed,
      vy: Math.sin((angle * Math.PI) / 180) * speed,
      size: 6 + Math.random() * 6,
      spin: Math.random() * Math.PI,
      spinSpeed: (Math.random() - 0.5) * 0.3,
      colour: colours[index % colours.length] ?? "currentColor",
    };
  });

  const started = performance.now();
  const frame = (now: number) => {
    const elapsed = now - started;
    context.clearRect(0, 0, width, height);
    context.globalAlpha = Math.max(
      0,
      1 - Math.max(0, elapsed - DURATION_MS * 0.6) / (DURATION_MS * 0.4),
    );
    for (const piece of pieces) {
      piece.vy += 0.28;
      piece.vx *= 0.99;
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.spin += piece.spinSpeed;
      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.spin);
      context.fillStyle = piece.colour;
      context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
      context.restore();
    }
    if (elapsed < DURATION_MS) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
