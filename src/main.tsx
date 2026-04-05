import React from "react";
import ReactDOM from "react-dom/client";

async function init() {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = getCurrentWebviewWindow().label;

  const { default: Component } = await import("./App");

  // Force overlay detection via a global flag before rendering
  (window as any).__QUERYLOL_OVERLAY__ = label === "overlay";

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Component />
    </React.StrictMode>,
  );
}

init();
