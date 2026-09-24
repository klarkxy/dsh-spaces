/** This is a presentation flag only. Host authorization is unchanged. */
export const HOME_VIEW_PARAM = "dsh-spaces-home";

export function homeViewUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(HOME_VIEW_PARAM, "1");
  return url.href;
}

export function isHomeView(href: string): boolean {
  return new URL(href).searchParams.get(HOME_VIEW_PARAM) === "1";
}
