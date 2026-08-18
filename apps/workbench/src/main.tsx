import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchApp } from "./app/WorkbenchApp";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Workbench root element is missing");

createRoot(rootElement).render(
  <StrictMode>
    <WorkbenchApp />
  </StrictMode>,
);
