import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DataApp } from "./DataApp.tsx";
import "./styles.css";
import "./data.css";
import { applyAppearance } from "./appearance.ts";

applyAppearance();

createRoot(document.getElementById("root")!).render(<StrictMode><DataApp /></StrictMode>);
