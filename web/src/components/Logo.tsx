import { useId } from "react";

/**
 * The Aurex mark: a gold tile with a white "A" whose crossbar is a two-way arrow
 * (money exchanged between people) and a spark (AI). Same artwork as public/favicon.svg.
 */
export function Logo({ size = 30, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={{ flex: "none", display: "block" }}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F7E2A0" />
          <stop offset="0.45" stopColor="#D9B44A" />
          <stop offset="1" stopColor="#A97B17" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#g${id})`} />
      <rect x="1.5" y="1.5" width="61" height="61" rx="13.5" fill="none" stroke="#FFF6D8" strokeOpacity="0.55" strokeWidth="1.5" />
      <path d="M14.5 50 L31 14.5 L47.5 50" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M25.5 41 H36.5 M28.5 38 L25.5 41 L28.5 44 M33.5 38 L36.5 41 L33.5 44" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M50 9.5 C50.6 13.2 51.8 14.4 55.5 15 C51.8 15.6 50.6 16.8 50 20.5 C49.4 16.8 48.2 15.6 44.5 15 C48.2 14.4 49.4 13.2 50 9.5 Z" fill="#fff" />
    </svg>
  );
}
