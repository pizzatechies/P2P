import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Modal } from "./ui";

/**
 * A live selfie with Smile ID's camera component (@smileid/web-sdk, <smart-camera-web>): it guides the
 * customer through a selfie and a few movements, then hands back the selfie and the liveness frames,
 * which go to Aurex and on to Smile ID's Biometric KYC. The component is loaded only when opened.
 */
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "smart-camera-web": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        "theme-color"?: string;
        "hide-attribution"?: string;
        "show-navigation"?: string;
      };
    }
  }
}

/** What the component publishes: event.detail.images, where type 2 is the selfie and 6 a liveness frame. */
export interface CapturePayload {
  images?: { image: string; image_type_id: number }[];
}

export function splitCapture(detail: CapturePayload) {
  const images = detail.images ?? [];
  const selfie = images.find((i) => i.image_type_id === 2)?.image ?? null;
  const liveness = images.filter((i) => i.image_type_id === 6).map((i) => i.image);
  return { selfie, liveness };
}

export function LiveSelfieButton({ captured, disabled, onSaved }: { captured: boolean; disabled: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn ${captured ? "ghost" : "secondary"} sm`} disabled={disabled} onClick={() => setOpen(true)}>
        {captured ? "Retake" : "Take a live selfie"}
      </button>
      {open && <LiveSelfieModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved(); }} />}
    </>
  );
}

function LiveSelfieModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("@smileid/web-sdk/smart-camera-web")
      .then(() => !cancelled && setReady(true))
      .catch(() => !cancelled && setError("The camera couldn't start. Check your connection and try again."));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    const publish = async (e: Event) => {
      const { selfie, liveness } = splitCapture((e as CustomEvent<CapturePayload>).detail ?? {});
      if (!selfie || liveness.length === 0) {
        setError("The capture didn't finish. Please try again.");
        return;
      }
      setSaving(true);
      setError(null);
      try {
        await api.post("/api/account/verification/liveness", { selfie, liveness });
        onSaved();
      } catch (err) {
        setError((err as Error).message);
        setSaving(false);
      }
    };
    const close = () => onClose();
    el.addEventListener("smart-camera-web.publish", publish);
    el.addEventListener("smart-camera-web.cancelled", close);
    el.addEventListener("smart-camera-web.close", close);
    return () => {
      el.removeEventListener("smart-camera-web.publish", publish);
      el.removeEventListener("smart-camera-web.cancelled", close);
      el.removeEventListener("smart-camera-web.close", close);
    };
  }, [ready, onClose, onSaved]);

  return (
    <Modal title="Take a live selfie" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Good light, face the camera, nothing covering your face. You'll be asked to move a little so we know it's really you. Your camera is used only for this.
      </p>
      {error && <p className="small bad">{error}</p>}
      {saving ? <p className="small">Saving your selfie…</p> : ready ? <smart-camera-web ref={ref} theme-color="#b8860b" hide-attribution="true" /> : !error && <p className="small muted">Starting the camera…</p>}
    </Modal>
  );
}
