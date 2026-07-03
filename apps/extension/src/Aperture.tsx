/**
 * The OculusVault mark: a guilloché rosette — the engraved "oculus" of a
 * banknote. Pure fine-line strokes in currentColor so it prints in whatever
 * ink surrounds it (ink on paper, paper on ink, gold on mainnet).
 */
export function Aperture({ size, hero = false }: { size: number; hero?: boolean }) {
  const petals = hero ? 36 : 24;
  const rings = hero ? [88, 62] : [88];
  return (
    <svg
      className={hero ? "rosette rosette-hero" : "rosette"}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      aria-hidden
    >
      {/* spirograph petals */}
      <g className="rosette-spin" stroke="currentColor" strokeWidth={hero ? 0.7 : 1} opacity="0.85">
        {Array.from({ length: petals }).map((_, i) => (
          <ellipse
            key={i}
            cx="100"
            cy="100"
            rx="86"
            ry="30"
            transform={`rotate(${(i * 180) / petals} 100 100)`}
          />
        ))}
      </g>
      {/* containment rings */}
      {rings.map((r) => (
        <circle key={r} cx="100" cy="100" r={r} stroke="currentColor" strokeWidth="1.4" />
      ))}
      <circle cx="100" cy="100" r="96" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5 3" />
      {/* the pupil */}
      <circle cx="100" cy="100" r="13" fill="currentColor" />
      <circle cx="100" cy="100" r="20" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
