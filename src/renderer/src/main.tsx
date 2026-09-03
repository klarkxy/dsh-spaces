import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getLocale, htmlLang } from "@shared/i18n";
import { resolveColorScheme } from "@shared/theme";
import App from "./App";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./theme";
import "./index.css";

document.documentElement.lang = htmlLang(getLocale());
const initialScheme = resolveColorScheme(
  "system",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);
document.documentElement.dataset.theme = initialScheme;
document.documentElement.style.colorScheme = initialScheme;

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
