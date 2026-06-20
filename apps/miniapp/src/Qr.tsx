import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders `value` as a QR code data-URL image. */
export function Qr({ value, size = 200 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(""));
    return () => {
      alive = false;
    };
  }, [value, size]);
  if (!src) return <div className="qr-placeholder" style={{ width: size, height: size }} />;
  return <img className="qr" src={src} width={size} height={size} alt="address QR" />;
}
