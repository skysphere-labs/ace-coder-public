import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { buildEnrollmentUrl } from '../lib/enrollment-url';

type Props = {
  url: string;
  enrollmentToken: string;
  size?: number;
};

export function RemoteAccessQR({ url, enrollmentToken, size = 224 }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const payload = buildEnrollmentUrl(url, enrollmentToken);
    QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((value) => {
        if (!cancelled) setDataUrl(value);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [url, enrollmentToken, size]);

  if (error) {
    return <p className="text-xs text-destructive">QR render failed: {error}</p>;
  }
  if (!dataUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-md bg-muted/30 text-xs text-muted-foreground"
        style={{ width: size, height: size }}
      >
        Generating…
      </div>
    );
  }
  return (
    <img
      src={dataUrl}
      alt="Ace enrollment QR"
      width={size}
      height={size}
      className="rounded-md border border-border bg-white p-2"
    />
  );
}
