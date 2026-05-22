// Small "heartbeat" dot that flashes with every incoming WS event from the
// backend, and goes red if no event has been seen in > staleMs milliseconds.
// Gives the operator an instant sense that the link is truly alive vs stale.

import React, { useEffect, useRef, useState } from "react";
import { useMachine } from "../lib/useMachine.jsx";

export default function SignalPulse({ staleMs = 2500, className = "" }) {
  const machine = useMachine();
  const [flash, setFlash] = useState(0); // incremented on each event
  const [stale, setStale] = useState(false);
  const lastSeenRef = useRef(Date.now());

  // Subscribe to raw events from the backend
  useEffect(() => {
    if (!machine.subscribe) return undefined;
    const off = machine.subscribe(() => {
      lastSeenRef.current = Date.now();
      setStale(false);
      setFlash((n) => (n + 1) & 0xffff);
    });
    return () => off?.();
  }, [machine]);

  // Mark stale if we haven't seen an event recently
  useEffect(() => {
    const t = setInterval(() => {
      const age = Date.now() - lastSeenRef.current;
      setStale(age > staleMs);
    }, 500);
    return () => clearInterval(t);
  }, [staleMs]);

  const connected = machine.state.connected;
  const color = !connected || stale ? "#f87171" : "#4ade80"; // red-400 / green-400

  return (
    <span
      key={flash}
      title={
        !connected
          ? "Disconnected"
          : stale
            ? "No recent events"
            : "Link active"
      }
      className={`relative inline-flex w-2.5 h-2.5 ${className}`}
      aria-label="Link signal"
    >
      {/* Solid dot */}
      <span
        className="absolute inset-0 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      />
      {/* Expanding ring, single-shot per event */}
      {connected && !stale && (
        <span
          className="absolute inset-0 rounded-full animate-ping"
          style={{ background: color, opacity: 0.55, animationDuration: "1.1s" }}
        />
      )}
    </span>
  );
}
