// Compact SVG ring spinner derived from the Ionetic logo mark.
// Draws the "four-arc broken ring" and spins it. No assets, pure SVG —
// cheap enough to drop anywhere (status bar, buttons, overlays).

import React from "react";

/**
 * Props:
 *   size:   px (default 16)
 *   stroke: stroke width (default 2)
 *   color:  stroke color (default currentColor)
 *   speed:  rotation period in seconds (default 1.4)
 *   title:  a11y label
 */
export default function RingSpinner({
  size = 16,
  stroke = 2,
  color = "currentColor",
  speed = 1.4,
  title = "Working",
  className = "",
}) {
  const id = React.useId();
  // Four arcs, each ~50° of a 64px viewBox ring, separated by gaps —
  // a simplified vector reproduction of the Ionetic ring mark.
  const arcs = [
    { d: "M 32 4 A 28 28 0 0 1 55.6 19.7" }, // top-right
    { d: "M 60 32 A 28 28 0 0 1 48 55.7" },  // bottom-right
    { d: "M 32 60 A 28 28 0 0 1 8.4 44.3" }, // bottom-left
    { d: "M 4 32 A 28 28 0 0 1 16 8.3" },    // top-left
  ];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`inline-block align-middle ${className}`}
      role="img"
      aria-label={title}
    >
      <style>{`
        @keyframes ring-spin-${id.replace(/:/g, "")} {
          from { transform: rotate(0deg);   }
          to   { transform: rotate(360deg); }
        }
        .rs-${id.replace(/:/g, "")} {
          transform-origin: 32px 32px;
          animation: ring-spin-${id.replace(/:/g, "")} ${speed}s linear infinite;
        }
      `}</style>
      <g
        className={`rs-${id.replace(/:/g, "")}`}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
      >
        {arcs.map((a, i) => (
          <path key={i} d={a.d} opacity={0.3 + i * 0.22} />
        ))}
      </g>
    </svg>
  );
}
