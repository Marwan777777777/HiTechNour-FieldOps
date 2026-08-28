import { useEffect, useId, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, X } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { type Locale, t } from "@/lib/i18n";
import { BrandMark } from "./chrome";

const FACEBOOK_URL = "https://www.facebook.com/HTNTechnologies/";
const LINKEDIN_URL = "https://eg.linkedin.com/company/hitechnourtechnologies-htn";
const ABOUT_URL = "https://hitechnour.net/about/";
const PARTNERS_URL = "https://hitechnour.net/partners/";
const SITE_URL = "https://hitechnour.net/";
const LOCALE_KEY = "htn-locale";

function toAuthEmail(username: string) {
  const value = username.trim().toLowerCase();
  if (value.includes("@")) return value;
  return `${value}@hitechnour.local`;
}

export function LoginScreen() {
  const navigate = useNavigate();
  const usernameId = useId();
  const passwordId = useId();
  const aboutTitleId = useId();
  const [locale, setLocale] = useState<Locale>("en");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgotHint, setForgotHint] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCALE_KEY);
    if (stored === "ar" || stored === "en") setLocale(stored);
  }, []);

  useEffect(() => {
    if (!aboutOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAboutOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aboutOpen]);

  function setAndStoreLocale(next: Locale) {
    setLocale(next);
    window.localStorage.setItem(LOCALE_KEY, next);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const email = toAuthEmail(username);
    const name = username.trim().split("@")[0] || email.split("@")[0];
    try {
      if (mode === "up") {
        const res = await authClient.signUp.email({ email, password, name });
        if (res.error) throw new Error(t(locale, "couldNotCreate"));
      } else {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(t(locale, "incorrectCreds"));
      }
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, "incorrectCreds"));
    } finally {
      setBusy(false);
    }
  }

  const rtl = locale === "ar";

  return (
    <main id="login-screen" dir={rtl ? "rtl" : "ltr"}>
      <div className="login-shell">
        <aside className="login-visual" aria-hidden="true">
          <div className="login-visual-glow" />
          <div className="login-visual-grid" />
          <div className="login-brand-lockup">
            <BrandMark lockup className="login-logo-full" />
          </div>
          <div className="login-visual-copy">
            <span className="eyebrow">{t(locale, "siteAttendance")}</span>
            <h2>{t(locale, "pitchTitle")}</h2>
            <p>{t(locale, "pitchBody")}</p>
          </div>
          <p className="login-visual-footer">HITECHNOUR · ATTENDANCE PLATFORM</p>
        </aside>

        <section className="login-panel">
          <div className="login-panel-top">
            <div className="login-mobile-brand">
              <BrandMark className="login-logo-mark" />
              <span className="login-brand-name">HiTechNour</span>
              <span className="login-brand-meta">OPERATIONS</span>
            </div>
            <div className="lang-toggle" role="group" aria-label={t(locale, "switchLang")}>
              <button
                type="button"
                className={locale === "ar" ? "is-active" : undefined}
                aria-pressed={locale === "ar"}
                onClick={() => setAndStoreLocale("ar")}
              >
                ع
              </button>
              <button
                type="button"
                className={locale === "en" ? "is-active" : undefined}
                aria-pressed={locale === "en"}
                onClick={() => setAndStoreLocale("en")}
              >
                EN
              </button>
            </div>
          </div>

          <div className="login-heading">
            <h1>{mode === "in" ? t(locale, "signIn") : t(locale, "signUp")}</h1>
            <p>{mode === "in" ? t(locale, "secureSignIn") : t(locale, "firstAdminHint")}</p>
          </div>

          <form className="login-form" onSubmit={onSubmit} autoComplete="on">
            <label htmlFor={usernameId}>
              {t(locale, "username")}
              <input
                id={usernameId}
                type="text"
                name="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                suppressHydrationWarning
              />
            </label>
            <label htmlFor={passwordId}>
              {t(locale, "password")}
              <span className="password-wrap">
                <input
                  id={passwordId}
                  type={showPassword ? "text" : "password"}
                  name="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "up" ? "new-password" : "current-password"}
                  suppressHydrationWarning
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={t(locale, showPassword ? "hidePassword" : "showPassword")}
                  title={t(locale, showPassword ? "hidePassword" : "showPassword")}
                >
                  <span className="icon-swap">
                    <Eye
                      className={showPassword ? "icon-off" : "icon-on"}
                      size={16}
                      strokeWidth={1.75}
                    />
                    <EyeOff
                      className={showPassword ? "icon-on" : "icon-off"}
                      size={16}
                      strokeWidth={1.75}
                    />
                  </span>
                </button>
              </span>
            </label>

            {mode === "in" ? (
              <div className="login-meta-row">
                <button
                  type="button"
                  className="forgot-link"
                  onClick={() => setForgotHint(true)}
                >
                  {t(locale, "forgot")}
                </button>
              </div>
            ) : null}

            {forgotHint ? <p className="login-hint">{t(locale, "forgotHint")}</p> : null}
            {error ? <p className="login-error">{error}</p> : null}

            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "…" : mode === "in" ? t(locale, "signInCta") : t(locale, "signUp")}
            </button>
          </form>

          <div className="login-social-links" aria-label="HiTechNour social media">
            <a
              className="social-link"
              href={FACEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t(locale, "facebook")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M13.5 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.6 1.7-1.6h1.7V3.8c-.3 0-1.3-.1-2.4-.1-2.4 0-4.1 1.5-4.1 4.2V10H7.7v3h2.7v8h3.1Z" />
              </svg>
            </a>
            <a
              className="social-link"
              href={LINKEDIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t(locale, "linkedin")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6.1 8.1H3V21h3.1V8.1ZM4.5 3A1.9 1.9 0 1 0 4.5 6.8 1.9 1.9 0 0 0 4.5 3ZM21 13.6c0-3.9-2.1-5.7-4.9-5.7-2.3 0-3.3 1.3-3.9 2.1V8.1H9.1V21h3.1v-6.4c0-1.7.3-3.3 2.4-3.3 2 0 2 1.9 2 3.4V21H21v-7.4Z" />
              </svg>
            </a>
          </div>

          <div className="login-company-links" aria-label="HiTechNour company links">
            <button type="button" className="company-link" onClick={() => setAboutOpen(true)}>
              {t(locale, "about")}
            </button>
            <span className="company-link-separator" aria-hidden="true" />
            <a className="company-link" href={PARTNERS_URL} target="_blank" rel="noopener noreferrer">
              {t(locale, "partners")}
            </a>
          </div>

          <button
            type="button"
            className="login-switch"
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setError("");
              setForgotHint(false);
            }}
          >
            {mode === "in" ? t(locale, "needAccount") : t(locale, "haveAccount")}
          </button>

          <div className="login-footer">
            <span>{t(locale, "platformFooter")}</span>
            <span>{t(locale, "secureAccess")}</span>
          </div>
        </section>
      </div>

      {aboutOpen ? (
        <div className="company-about-dialog" role="dialog" aria-modal="true" aria-labelledby={aboutTitleId}>
          <button
            type="button"
            className="company-about-backdrop"
            aria-label={t(locale, "close")}
            onClick={() => setAboutOpen(false)}
          />
          <section className="company-about-card">
            <button
              type="button"
              className="company-about-close"
              onClick={() => setAboutOpen(false)}
              aria-label={t(locale, "close")}
            >
              <X size={16} strokeWidth={1.75} />
            </button>
            <div className="company-about-brand">
              <BrandMark />
              <div>
                <strong>HiTechNour Technologies</strong>
                <span>{t(locale, "aboutEstablished")}</span>
              </div>
            </div>
            <span className="company-about-kicker">{t(locale, "aboutKicker")}</span>
            <h2 id={aboutTitleId}>{t(locale, "aboutTitle")}</h2>
            <p>{t(locale, "aboutBody")}</p>
            <div className="company-about-actions">
              <a className="primary-button" href={SITE_URL} target="_blank" rel="noopener noreferrer">
                {t(locale, "visitSite")}
              </a>
              <a className="text-link" href={ABOUT_URL} target="_blank" rel="noopener noreferrer">
                {t(locale, "about")}
              </a>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
