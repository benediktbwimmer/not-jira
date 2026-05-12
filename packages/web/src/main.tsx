import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import "./styles.css";

type UnblockWindow = Window & typeof globalThis & { __unblockRoot?: Root };

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element.");
}
const unblockWindow = window as UnblockWindow;
const root = unblockWindow.__unblockRoot ?? createRoot(rootElement);
unblockWindow.__unblockRoot = root;
root.render(<StrictMode><App /></StrictMode>);
