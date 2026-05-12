export function withProject(path: string, projectId: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

export function getKeyboardShortcuts(): { suggest: string } {
  return { suggest: `${isMacPlatform() ? "Command" : "Ctrl"} + Space` };
}

export function isMacPlatform(): boolean {
  const nav = window.navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function mutate(url: string, options: { method: string; body?: unknown }): Promise<void> {
  await mutateResponse(url, options);
}

export async function mutateJson<T>(url: string, options: { method: string; body?: unknown }): Promise<T> {
  const response = await mutateResponse(url, options);
  return response.json() as Promise<T>;
}

export async function mutateResponse(url: string, options: { method: string; body?: unknown }): Promise<Response> {
  const init: RequestInit = {
    method: options.method,
  };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response;
}
