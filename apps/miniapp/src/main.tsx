import React from "react";
import ReactDOM from "react-dom/client";
import { initTelegram } from "@oculusvault/sdk";
import { App } from "./App.js";
import "./styles.css";

initTelegram();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
