import { Fingerprint, LogOut, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut } from "@/lib/auth/client";
import {
  enrollWorkerBiometric,
  hasEnrolledBiometric,
  platformBiometricsAvailable,
  verifyWorkerBiometric,
} from "@/lib/device-bind";
import { type Locale, t } from "@/lib/i18n";
import { saveBiometric } from "@/lib/server/field";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/chrome";

type Phase = "check" | "enroll" | "unlock" | "ready" | "unsupported";

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
  const hiddenAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await platformBiometricsAvailable();
      if (cancelled) return;
      if (!ok) {
        setPhase("unsupported");
        return;
      }
      const enrolled = await hasEnrolledBiometric();
      if (cancelled) return;
      setPhase(enrolled ? "unlock" : "enroll");
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
      if (phase === "ready" && Date.now() - hiddenAt.current > 30_000) {
        setPhase("unlock");
        setError("");
      }
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
      setPhase("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "BIO_UNSUPPORTED") setPhase("unsupported");
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
      setPhase("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "BIO_MISSING") setPhase("enroll");
      else if (msg === "BIO_UNSUPPORTED") setPhase("unsupported");
      else setError(t(locale, "bioFailed"));
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

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
      <BrandMark className="h-14 w-auto" />
      {phase === "unsupported" ? (
        <ShieldAlert className="size-10 text-warn" />
      ) : (
        <Fingerprint className="size-10 text-accent" />
      )}
      <div>
        <h1 className="font-display text-xl font-semibold">
          {phase === "enroll"
            ? t(locale, "bioEnrollTitle")
            : phase === "unsupported"
              ? t(locale, "bioUnsupportedTitle")
              : t(locale, "bioUnlockTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {phase === "enroll"
            ? t(locale, "bioEnrollBody")
            : phase === "unsupported"
              ? t(locale, "bioUnsupportedBody")
              : t(locale, "bioUnlockBody")}
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
