import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DataApp } from "./DataApp.tsx";
import "./styles.css";
import "./data.css";

createRoot(document.getElementById("root")!).render(<StrictMode><DataApp /></StrictMode>);
