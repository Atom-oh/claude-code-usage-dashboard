import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import ConfigBootstrap from "./ConfigBootstrap.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ConfigBootstrap>
      {(config) => (
        <BrowserRouter>
          <ConfigProvider config={config}>
            <App />
          </ConfigProvider>
        </BrowserRouter>
      )}
    </ConfigBootstrap>
  </StrictMode>
);
