import "../styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { HelpGuide } from "./HelpGuide";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <HelpGuide />
    </StrictMode>,
  );
}
