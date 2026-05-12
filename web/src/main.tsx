import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./foundation.css";
import { App } from "./App.js";
import { wsClient } from "./lib/ws-client.js";

// WS broadcast に即接続. ページ遷移しても singleton で生き続ける.
wsClient.connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
