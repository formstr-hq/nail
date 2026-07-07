import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import App from "./App";

/** Render a route to an HTML string for build-time prerendering. */
export function render(url: string) {
  return renderToString(
    <StrictMode>
      <App url={url} />
    </StrictMode>,
  );
}
