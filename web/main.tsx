/**
 * The UI, bundled for any host.
 *
 * The same `FlowwingApp` component the Pi serves through Next, built by Vite into static assets so a
 * Worker can serve it too. One component, one stylesheet, two hosts — the point being that the
 * Cloudflare side must not grow its own interface.
 */
import { createRoot } from "react-dom/client";

import FlowwingApp from "../components/FlowwingApp";
import "../app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root to mount into");
createRoot(root).render(<FlowwingApp />);
