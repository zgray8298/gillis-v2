// Loading / spinner components built around the real Ionetic loading gif.
// The gif already carries the brand ring mark, so we just present it with
// consistent sizing + an optional fullscreen overlay for "waiting" moments.

import React from "react";

const SIZES = {
  xs: "w-6 h-6",
  sm: "w-10 h-10",
  md: "w-16 h-16",
  lg: "w-24 h-24",
  xl: "w-40 h-40",
  "2xl": "w-56 h-56",
};

/**
 * Inline spinner that uses the Ionetic loading gif.
 * Props:
 *   size: xs|sm|md|lg|xl|2xl  (default: md)
 *   className: extra classes for the wrapper
 *   label: optional text shown beneath the gif
 */
export function Loading({ size = "md", className = "", label = null }) {
  const sizeCls = SIZES[size] || SIZES.md;
  return (
    <div className={`inline-flex flex-col items-center justify-center ${className}`}>
      <img
        src="/brand/loading.gif"
        alt="Loading"
        className={`${sizeCls} object-contain select-none pointer-events-none`}
        draggable={false}
      />
      {label && (
        <div className="mt-2 text-slate-300 text-sm tracking-[0.18em] uppercase">
          {label}
        </div>
      )}
    </div>
  );
}

/**
 * Fullscreen glass overlay for blocking/waiting states.
 * Props:
 *   visible:  boolean
 *   title:    primary message  (e.g. "Homing axes")
 *   subtext:  smaller secondary line
 *   size:     passed through to the inner spinner (default: xl)
 *   onCancel: optional — if provided, shows a Cancel button wired to this handler
 *   children: optional — rendered between the subtext and the Cancel button.
 *             Used by homing overlays to tick a live X/Y coordinate readout
 *             below the spinner so the operator can see the axes moving.
 */
export function LoadingOverlay({
  visible,
  title = "Working...",
  subtext = null,
  size = "xl",
  onCancel = null,
  children = null,
}) {
  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md bg-slate-950/70"
      role="status"
      aria-live="polite"
    >
      {/* Soft radial glow behind the spinner */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 50% 45%, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.06) 25%, rgba(2,6,23,0) 60%)",
        }}
      />

      <div className="relative flex flex-col items-center">
        <Loading size={size} />

        <div className="mt-6 text-slate-100 text-xl font-semibold tracking-[0.12em] uppercase">
          {title}
        </div>
        {subtext && (
          <div className="mt-2 text-slate-400 text-sm max-w-md text-center">
            {subtext}
          </div>
        )}

        {children && (
          <div className="mt-5">
            {children}
          </div>
        )}

        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-8 px-5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 text-sm"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default Loading;
