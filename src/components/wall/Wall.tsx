'use client';

import { useEffect, useRef } from 'react';
import type { WallLayout } from '@/lib/placement/service';
import { mountWall } from './engine';
import './wall.css';

const Close = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
const Chevron = ({ dir }: { dir: 'prev' | 'next' }) => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d={dir === 'prev' ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function Wall({ layout, openNumber }: { layout: WallLayout; openNumber?: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    return mountWall(root.current, layout, { openNumber });
    // The layout object is stable per page render; re-mounting on navigation is intended.
  }, [layout, openNumber]);

  return (
    <div className="wall-root" ref={root}>
      <main id="stage" aria-label="Polaroid wall">
        <div id="world" />
      </main>
      <div id="room" aria-hidden="true" />
      <div className="scrim scrim-top" aria-hidden="true" />
      <div className="scrim scrim-bottom" aria-hidden="true" />

      <header className="pill title"><span className="name">Bobby Banks</span><span className="muted">Polaroids</span></header>

      <div id="viewer" role="dialog" aria-modal="true" aria-label="Print" tabIndex={-1} hidden>
        <div className="veil" id="veil" />
        <div className="vstage" id="vstage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img id="vimg" alt="" draggable={false} />
        </div>
        <button className="ibtn close" id="vclose" type="button" aria-label="Close"><Close /></button>
        <button className="ibtn side prev" id="vprev" type="button" aria-label="Previous print"><Chevron dir="prev" /></button>
        <button className="ibtn side next" id="vnext" type="button" aria-label="Next print"><Chevron dir="next" /></button>
      </div>
    </div>
  );
}
