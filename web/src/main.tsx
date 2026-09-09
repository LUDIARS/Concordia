import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./foundation.css";
import { App } from "./App.js";
import { wsClient } from "./lib/ws-client.js";
import { getViewerBasename } from "./viewer-basename.js";

const viewerBasename = getViewerBasename();

// WS broadcast に即接続. ページ遷移しても singleton で生き続ける.
wsClient.connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={viewerBasename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
