import type { DshSpacesApi } from "../../preload/index";

declare global {
  interface Window {
    dshSpaces: DshSpacesApi;
  }
}

export {};
