import { useRef } from "react";
import { Link } from "react-router-dom";
import { CtaBand, Section, usePageTitle } from "./common";

const BASE = import.meta.env.BASE_URL;

export const CHAPTERS: { t: number; label: string }[] = [
  { t: 0, label: "Welcome to Aurex" },
  { t: 5, label: "Create an account" },
  { t: 10, label: "Add money and send by @handle" },
  { t: 15, label: "Business accounts" },
  { t: 19, label: "Help and complaints" },
  { t: 25, label: "Fees and limits" },
  { t: 29, label: "The support inbox" },
  { t: 37, label: "AI and trading" },
  { t: 43, label: "Wrap-up" },
];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The product demo video. Loads nothing until played, which keeps the page light on mobile data. */
export function DemoVideo({ withChapters }: { withChapters?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const jump = (t: number) => {
    const v = ref.current;
    if (!v) return;
    const go = () => {
      v.currentTime = t;
      void v.play().catch(() => undefined);
    };
    // With preload="none" nothing is loaded yet, and seeking before the metadata arrives is ignored.
    if (v.readyState >= 1) go();
    else {
      v.addEventListener("loadedmetadata", go, { once: true });
      v.preload = "metadata";
      v.load();
    }
  };
  return (
    <div className={withChapters ? "demo-layout" : ""}>
      <div className="demo-frame">
        <video
          ref={ref}
          controls
          playsInline
          preload="none"
          poster={`${BASE}demo/tour-poster.jpg`}
          aria-label="Aurex product tour, 46 seconds, with on-screen captions"
        >
          <source src={`${BASE}demo/aurex-tour.mp4`} type="video/mp4" />
          Your browser can't play this video. <a href={`${BASE}demo/aurex-tour.mp4`}>Download the tour (MP4)</a>.
        </video>
      </div>
      {withChapters && (
        <ol className="chapters" aria-label="Chapters">
          {CHAPTERS.map((c) => (
            <li key={c.t}>
              <button type="button" onClick={() => jump(c.t)}>
                <span className="chapter-time num">{mmss(c.t)}</span>
                <span>{c.label}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function DemoPage() {
  usePageTitle("Demo");
  return (
    <>
      <section className="page-hero">
        <div className="site-container">
          <span className="eyebrow">Demo</span>
          <h1>See Aurex <span className="gold-text">in action.</span></h1>
          <p className="lead">A 46-second tour: open an account, add money and send it by @handle, pay a verified business, ask for help and get a reference number, check fees and limits, see how the support team answers, and get an AI view on a stock. Captions are on screen, so no sound is needed.</p>
        </div>
      </section>
      <Section>
        <DemoVideo withChapters />
        <p className="faint small" style={{ marginTop: 16 }}>
          Recorded in the real app. The demo uses test money, a test M-Pesa connection, a demo bank, simulated market prices and the built-in offline AI
          assistant; connected AI providers give model-written answers. Trading signals are educational and not financial advice. See <Link to="/security#disclosures">disclosures</Link>.
        </p>
      </Section>
      <CtaBand title="Ready to try it yourself?" />
    </>
  );
}
