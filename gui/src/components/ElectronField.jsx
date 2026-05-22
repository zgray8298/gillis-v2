// Ambient "electron path" background field.
// Thin blue light streaks drift across the canvas at slightly different
// speeds, with soft trails — evocative of the Ionetic brand motif without
// being loud. Draws to a fixed-resolution canvas scaled with CSS so cost
// is constant regardless of screen size.

import React, { useEffect, useRef } from "react";

const W = 800;
const H = 480;

export default function ElectronField({
  className = "",
  density = 38,      // number of streaks
  accent = "#60a5fa", // tailwind blue-400
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    canvas.width = W;
    canvas.height = H;

    // Initialize streaks: position, velocity, length, alpha
    const streaks = Array.from({ length: density }, () => makeStreak());

    let running = true;
    let lastT = performance.now();

    const tick = (t) => {
      if (!running) return;
      const dt = Math.min(50, t - lastT) / 1000; // clamp to avoid huge leaps
      lastT = t;

      // Fade previous frame for trail effect
      ctx.fillStyle = "rgba(2, 6, 23, 0.22)"; // slate-950 w/ alpha
      ctx.fillRect(0, 0, W, H);

      ctx.lineCap = "round";
      for (const s of streaks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;

        if (s.x < -s.len || s.x > W + s.len || s.y < -s.len || s.y > H + s.len) {
          Object.assign(s, makeStreak(true));
        }

        // Gradient along the streak
        const nx = s.vx / s.speed;
        const ny = s.vy / s.speed;
        const x2 = s.x - nx * s.len;
        const y2 = s.y - ny * s.len;
        const grad = ctx.createLinearGradient(s.x, s.y, x2, y2);
        grad.addColorStop(0, hexWithAlpha(accent, s.alpha));
        grad.addColorStop(1, hexWithAlpha(accent, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = s.w;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Bright head pixel
        ctx.fillStyle = hexWithAlpha("#ffffff", Math.min(1, s.alpha + 0.15));
        ctx.fillRect(s.x - 0.5, s.y - 0.5, 1.5, 1.5);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [density, accent]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none ${className}`}
      style={{
        width: "100%",
        height: "100%",
        mixBlendMode: "screen",
        opacity: 0.8,
      }}
    />
  );
}

function makeStreak(fromEdge = false) {
  // Drift roughly diagonally, random-ish angle in a ±30° cone
  const angle = -Math.PI / 6 + Math.random() * (Math.PI / 3);
  const speed = 40 + Math.random() * 110; // px/s
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  // Start either anywhere (initial fill) or just off the left edge
  const x = fromEdge ? -20 : Math.random() * W;
  const y = fromEdge ? Math.random() * H : Math.random() * H;
  return {
    x, y, vx, vy, speed,
    len: 40 + Math.random() * 90,
    w: 0.6 + Math.random() * 1.1,
    alpha: 0.15 + Math.random() * 0.5,
  };
}

function hexWithAlpha(hex, a) {
  // Accepts "#rrggbb" or "#rgb"
  let r = 96, g = 165, b = 250;
  if (hex?.startsWith("#") && hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else if (hex?.startsWith("#") && hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  }
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
