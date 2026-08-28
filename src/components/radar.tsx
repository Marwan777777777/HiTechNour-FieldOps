type Props = {
  ratio: number;
  inside: boolean;
  locating: boolean;
};

export function Radar({ ratio, inside, locating }: Props) {
  const clamped = Math.min(1, Math.max(0.08, ratio));
  return (
    <div className="relative mx-auto aspect-square w-full max-w-72">
      <div className="absolute inset-0 rounded-full border border-line" />
      <div className="absolute inset-[12%] rounded-full border border-line/70" />
      <div className="absolute inset-[28%] rounded-full border border-line/50" />
      <div
        className={`absolute inset-[42%] rounded-full border ${inside ? "border-ok/50 bg-ok/10" : "border-warn/40 bg-warn/5"}`}
      />
      <div className="radar-sweep absolute inset-0 rounded-full" />
      <div
        className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_12px_var(--color-accent)]"
        style={{
          left: `${50 + Math.cos(clamped * Math.PI) * 32}%`,
          top: `${50 + Math.sin(clamped * Math.PI * 1.4) * (inside ? 18 : 32)}%`,
        }}
      />
      {locating ? (
        <div className="absolute inset-0 grid place-items-center text-xs text-muted">…</div>
      ) : null}
    </div>
  );
}
