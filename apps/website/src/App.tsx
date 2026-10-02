import { MotionConfig } from "motion/react";

import { ReleaseContext, useRelease } from "./release";

import { Download, Footer } from "./components/Download";
import { Exports } from "./components/Exports";
import { Features } from "./components/Features";
import { Hero, Nav } from "./components/Hero";
import { NewInOne } from "./components/NewInOne";
import { HowItWorks, Offline } from "./components/Story";
import { Support } from "./components/Support";

/** steps.amluto.com: what Steps does, and where to download it. */
export function App() {
  const release = useRelease();
  return (
    // Every animation follows the visitor's reduced-motion setting.
    <ReleaseContext.Provider value={release}>
      <MotionConfig reducedMotion="user">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-20 focus:rounded-full focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
        >
          Skip to the content
        </a>
        <Nav />
        {/* The hero's screenshot runs off the right edge on wide screens; nothing scrolls sideways. */}
        <main id="main" className="overflow-x-clip">
          <Hero />
          <Offline />
          <HowItWorks />
          <Features />
          <Exports />
          <NewInOne />
          <Download />
          <Support />
        </main>
        <Footer />
      </MotionConfig>
    </ReleaseContext.Provider>
  );
}
