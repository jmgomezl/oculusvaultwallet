/** The OculusVault mark: a concentric aperture / vault-eye. Shared by the
 * landing page and the wallet chrome. */
export function Aperture({ size, hero = false }: { size: number; hero?: boolean }) {
  return (
    <svg
      className={hero ? "lp-aperture lp-aperture-hero" : "lp-aperture"}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="ap-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c5cff" />
          <stop offset="1" stopColor="#00e0c6" />
        </linearGradient>
        <radialGradient id="ap-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#00e0c6" stopOpacity="0.9" />
          <stop offset="0.6" stopColor="#7c5cff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#7c5cff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="92" stroke="url(#ap-g)" strokeWidth="1.5" opacity="0.55" />
      <circle
        className="lp-ring-dash"
        cx="100"
        cy="100"
        r="74"
        stroke="url(#ap-g)"
        strokeWidth="2"
        strokeDasharray="6 10"
        opacity="0.8"
      />
      {hero &&
        Array.from({ length: 6 }).map((_, i) => (
          <line
            key={i}
            x1="100"
            y1="100"
            x2="100"
            y2="38"
            stroke="url(#ap-g)"
            strokeWidth="6"
            strokeLinecap="round"
            opacity="0.5"
            transform={`rotate(${i * 60} 100 100)`}
          />
        ))}
      <circle cx="100" cy="100" r="46" fill="url(#ap-core)" />
      <circle cx="100" cy="100" r="20" fill="#00e0c6" opacity="0.95" />
      <circle cx="100" cy="100" r="20" stroke="#0a0b0f" strokeWidth="3" />
    </svg>
  );
}
