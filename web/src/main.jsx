import React from "react";
import { createRoot } from "react-dom/client";
import { installStorage } from "./storage-adapter.js";
import DeviceIndex from "./device-index.jsx";

// Must run before the component mounts: it reads window.storage on first render.
const backend = installStorage();
console.info(`[device-registry] storage backend: ${backend}`);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DeviceIndex />
  </React.StrictMode>
);
