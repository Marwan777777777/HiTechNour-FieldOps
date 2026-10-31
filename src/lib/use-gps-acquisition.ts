import { useEffect, useRef, useState } from "react";
import {
  createGpsAcquisition,
  type GpsController,
  type GpsReading,
  type GpsPhase,
  type GpsSnapshot,
} from "./gps-acquisition";

export type GpsPermState = "unknown" | "granted" | "prompt" | "denied";

/**
 * React binding for the GPS acquisition controller. Owns the watch lifecycle
 * (start once permission is granted, always clean up on unmount) so screens
 * only read `reading` / `phase` and call `start()` to retry.
 */
export function useGpsAcquisition(): {
  reading: GpsReading | null;
  phase: GpsPhase;
  permState: GpsPermState;
  start: () => void;
} {
  const [snap, setSnap] = useState<GpsSnapshot>({ phase: "idle", reading: null });
  const [permState, setPermState] = useState<GpsPermState>("unknown");
  const ctlRef = useRef<GpsController | null>(null);

  if (!ctlRef.current) {
    ctlRef.current = createGpsAcquisition({
      geo: typeof navigator !== "undefined" && "geolocation" in navigator ? navigator.geolocation : null,
      onChange: setSnap,
    });
  }
  const ctl = ctlRef.current;

  useEffect(() => {
    let cancelled = false;
    let status: PermissionStatus | null = null;

    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      // Controller was built with geo=null; start() just reports "unsupported".
      ctl.start();
      return () => ctl.stop();
    }
    if (!navigator.permissions?.query) {
      ctl.start();
      return () => ctl.stop();
    }

    navigator.permissions
      .query({ name: "geolocation" })
      .then((result) => {
        if (cancelled) return;
        status = result;
        setPermState(result.state);
        if (result.state === "granted") ctl.start();
        result.onchange = () => {
          setPermState(result.state);
          if (result.state === "granted") ctl.start();
        };
      })
      .catch(() => {
        if (!cancelled) ctl.start();
      });

    return () => {
      cancelled = true;
      if (status) status.onchange = null;
      ctl.stop();
    };
  }, [ctl]);

  // Any real reading proves permission is granted (covers browsers whose
  // Permissions API reports "prompt" until the first successful fix).
  useEffect(() => {
    if (snap.reading) setPermState("granted");
    if (snap.phase === "denied") setPermState("denied");
  }, [snap.reading, snap.phase]);

  return { reading: snap.reading, phase: snap.phase, permState, start: ctl.start };
}
