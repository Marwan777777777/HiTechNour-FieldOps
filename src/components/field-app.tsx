import { Languages, LogOut, Shield } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { signOut } from "@/lib/auth/client";
import { type Locale, t } from "@/lib/i18n";
import { bootstrap, type HomeData } from "@/lib/server/field";
import { updateLocale } from "@/lib/server/field";
import { getDeviceId } from "@/lib/device-bind";
import { Button } from "@/components/ui/button";
import { AlertsBell } from "./alerts-bell";
import { BiometricGate } from "./biometric-gate";
import { BrandMark } from "./chrome";
import { WorkerApp } from "./worker-app";

const AdminApp = lazy(() => import("./admin-app").then((m) => ({ default: m.AdminApp })));

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 20_000, refetchOnWindowFocus: false },
    },
  });

export function FieldApp({
  email,
  displayName,
}: {
  email?: string;
  displayName?: string;
}) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <FieldShell email={email} displayName={displayName} />
    </QueryClientProvider>
  );
}

function FieldShell({ email, displayName }: { email?: string; displayName?: string }) {
  const [home, setHome] = useState<HomeData | null>(null);
  const [locale, setLocale] = useState<Locale>("en");

  const boot = useQuery({
    queryKey: ["htn-home"],
    queryFn: async () =>
      bootstrap({ data: { email, name: displayName, deviceId: await getDeviceId() } }),
  });

  useEffect(() => {
    const stored = localStorage.getItem("htn_locale") as Locale | null;
    if (stored === "ar" || stored === "en") setLocale(stored);
  }, []);

  useEffect(() => {
    if (boot.data) {
      setHome(boot.data);
      const loc = boot.data.me.locale === "ar" ? "ar" : "en";
      setLocale(loc);
    }
  }, [boot.data]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    localStorage.setItem("htn_locale", locale);
  }, [locale]);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | undefined;
    let refreshing = false;

    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    const checkForUpdate = () => {
      void registration?.update().catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", checkForUpdate);

    void navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration = reg;
        checkForUpdate();
      })
      .catch(() => undefined);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", checkForUpdate);
    };
  }, []);

  if (boot.isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <Toaster theme="dark" position="top-center" />
        <div className="max-w-sm text-center">
          <p className="text-bad">{t(locale, "loadError")}</p>
          <Button className="mt-4" onClick={() => void boot.refetch()}>
            {t(locale, "retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!home) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <div className="size-10 animate-pulse rounded-full border border-line bg-elevated" />
      </div>
    );
  }

  const isAdmin = home.me.role === "admin";

  const shell = (
    <div className="min-h-dvh bg-bg">
      <Toaster theme="dark" position="top-center" />
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark className="h-14 w-auto md:h-16" />
          <div className="min-w-0">
            <p className="font-display text-base font-semibold leading-none md:text-lg">{t(locale, "brand")}</p>
            <p className="mt-1 text-xs uppercase tracking-widest text-muted">
              {isAdmin ? t(locale, "adminDesk") : t(locale, "tagline")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="min-h-11 rounded-full border border-line px-3 text-xs text-muted"
            onClick={() => {
              const next = locale === "en" ? "ar" : "en";
              setLocale(next);
              void updateLocale({ data: { locale: next } });
            }}
          >
            <Languages className="me-1 inline size-3" />
            {locale === "en" ? "ع" : "EN"}
          </button>
          <AlertsBell locale={locale} unread={home.unread} />
          <Button variant="ghost" onClick={() => void signOut()}>
            <LogOut className="size-4" />
            <span className="sr-only">{t(locale, "signOut")}</span>
          </Button>
        </div>
      </header>
      {!home.me.active && !isAdmin ? (
        <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
          <Shield className="size-8 text-warn" />
          <p className="font-display text-xl font-semibold">{t(locale, "accountPending")}</p>
          <Button className="mt-2" variant="outline" onClick={() => void boot.refetch()}>
            {t(locale, "retry")}
          </Button>
        </div>
      ) : isAdmin ? (
        <Suspense
          fallback={
            <div className="grid min-h-[40vh] place-items-center">
              <div className="size-10 animate-pulse rounded-full border border-line bg-elevated" />
            </div>
          }
        >
          <AdminApp home={home} locale={locale} onHome={setHome} />
        </Suspense>
      ) : (
        <WorkerApp home={home} locale={locale} onHome={setHome} />
      )}
    </div>
  );

  if (isAdmin) return shell;

  return (
    <BiometricGate locale={locale} userId={home.me.user_id} displayName={home.me.full_name}>
      {shell}
    </BiometricGate>
  );
}
