import "../styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ItGuide } from "./ItGuide";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ItGuide />
    </StrictMode>,
  );
}
