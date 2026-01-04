import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { TextProvider } from "./i18n/TextProvider";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TextProvider>
      <App />
    </TextProvider>
  </React.StrictMode>
);
