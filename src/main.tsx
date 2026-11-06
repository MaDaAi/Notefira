import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "./styles/base.css";
import "./styles/app.css";
import { App } from "./App";
import { isTauri } from "./platform/native";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support for the web / PWA build (the desktop app ships its files locally).
if ("serviceWorker" in navigator && !isTauri() && location.protocol !== "file:" && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker registration failed", e));
  });
}
