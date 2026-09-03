import { Fingerprint, LogOut } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut } from "@/lib/auth/client";
import {
  enrollWorkerBiometric,
  hasEnrolledBiometric,
  platformBiometricsAvailable,
  verifyWorkerBiometric,
} from "@/lib/device-bind";
import { type Locale, t } from "@/lib/i18n";
import { getPinStatus, saveBiometric, setDevicePin, verifyDevicePin } from "@/lib/server/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/chrome";

/**
 * "unsupported" no longer means "give up" — it means the phone has no
 * platform authenticator (missing sensor, or one that's never been enrolled
 * at the OS level), so we fall back to a PIN. pin-enroll/pin-unlock cover it.
 */
type Phase = "check" | "enroll" | "unlock" | "ready" | "pin-enroll" | "pin-unlock";

export function BiometricGate({
  locale,
  userId,
  displayName,
  children,
}: {
  locale: Locale;
  userId: string;
  displayName: string;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("check");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pin, setPinValue] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const hiddenAt = useRef(0);
  const lockMechanism = useRef<"bio" | "pin">("bio");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bioOk = await platformBiometricsAvailable();
      if (cancelled) return;
      if (bioOk) {
        const enrolled = await hasEnrolledBiometric();
        if (cancelled) return;
        setPhase(enrolled ? "unlock" : "enroll");
        return;
      }
      const { hasPin } = await getPinStatus();
      if (cancelled) return;
      setPhase(hasPin ? "pin-unlock" : "pin-enroll");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        hiddenAt.current = Date.now();
        return;
      }
      if (phase !== "ready" || Date.now() - hiddenAt.current <= 30_000) return;
      setError("");
      setPinValue("");
      setPinConfirm("");
      setPhase(lockMechanism.current === "pin" ? "pin-unlock" : "unlock");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase]);

  async function enroll() {
    setBusy(true);
    setError("");
    try {
      const id = await enrollWorkerBiometric({ userId, displayName });
      await saveBiometric({ data: { credentialId: id } });
      lockMechanism.current = "bio";
      setPhase("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "BIO_UNSUPPORTED") setPhase("pin-enroll");
      else setError(t(locale, "bioFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setBusy(true);
    setError("");
    try {
      await verifyWorkerBiometric();
      lockMechanism.current = "bio";
      setPhase("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "BIO_MISSING") setPhase("enroll");
      else if (msg === "BIO_UNSUPPORTED") setPhase("pin-enroll");
      else setError(t(locale, "bioFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function submitPinEnroll() {
    setError("");
    if (!/^\d{4,8}$/.test(pin)) {
      setError(t(locale, "pinInvalid"));
      return;
    }
    if (pin !== pinConfirm) {
      setError(t(locale, "pinMismatch"));
      setPinConfirm("");
      return;
    }
    setBusy(true);
    try {
      await setDevicePin({ data: { pin } });
      lockMechanism.current = "pin";
      setPhase("ready");
    } catch {
      setError(t(locale, "pinInvalid"));
    } finally {
      setBusy(false);
    }
  }

  async function submitPinUnlock() {
    setError("");
    setBusy(true);
    try {
      await verifyDevicePin({ data: { pin } });
      lockMechanism.current = "pin";
      setPhase("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setPinValue("");
      if (msg === "PIN_LOCKED") setError(t(locale, "pinLocked"));
      else setError(t(locale, "pinWrong"));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "ready") return children;
  if (phase === "check") {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <div className="size-10 animate-pulse rounded-full border border-line bg-elevated" />
      </div>
    );
  }

  if (phase === "pin-enroll" || phase === "pin-unlock") {
    const isEnroll = phase === "pin-enroll";
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
        <BrandMark className="h-14 w-auto" />
        <Fingerprint className="size-10 text-accent" />
        <div>
          <h1 className="font-display text-xl font-semibold">
            {t(locale, isEnroll ? "pinEnrollTitle" : "pinUnlockTitle")}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {t(locale, isEnroll ? "pinEnrollBody" : "pinUnlockBody")}
          </p>
        </div>
        <div className="w-full max-w-[220px] space-y-3">
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
            placeholder={isEnroll ? t(locale, "pinEnrollTitle") : t(locale, "pinUnlockTitle")}
            className="text-center text-lg tracking-[0.4em]"
          />
          {isEnroll ? (
            <>
              <p className="text-xs text-muted">{t(locale, "pinConfirmBody")}</p>
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                value={pinConfirm}
                onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))}
                className="text-center text-lg tracking-[0.4em]"
              />
            </>
          ) : null}
        </div>
        {error ? <p className="text-sm text-bad">{error}</p> : null}
        <Button
          disabled={busy || !pin || (isEnroll && !pinConfirm)}
          onClick={() => void (isEnroll ? submitPinEnroll() : submitPinUnlock())}
        >
          {busy ? "…" : t(locale, isEnroll ? "pinEnrollCta" : "pinUnlockCta")}
        </Button>
        <Button variant="outline" onClick={() => void signOut()}>
          <LogOut className="size-4" /> {t(locale, "signOut")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
      <BrandMark className="h-14 w-auto" />
      <Fingerprint className="size-10 text-accent" />
      <div>
        <h1 className="font-display text-xl font-semibold">
          {t(locale, phase === "enroll" ? "bioEnrollTitle" : "bioUnlockTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {t(locale, phase === "enroll" ? "bioEnrollBody" : "bioUnlockBody")}
        </p>
      </div>
      {error ? <p className="text-sm text-bad">{error}</p> : null}
      {phase === "enroll" ? (
        <Button disabled={busy} onClick={() => void enroll()}>
          {busy ? "…" : t(locale, "bioEnrollCta")}
        </Button>
      ) : null}
      {phase === "unlock" ? (
        <Button disabled={busy} onClick={() => void unlock()}>
          {busy ? "…" : t(locale, "bioUnlockCta")}
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => void signOut()}>
        <LogOut className="size-4" /> {t(locale, "signOut")}
      </Button>
    </div>
  );
}
