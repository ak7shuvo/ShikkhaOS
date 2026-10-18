/** Renderer hardening shared by main.ts and the tests. Pure data/functions: no Electron import. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'shikkha';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The renderer is sandboxed, isolated from Node.js and cannot use remote content, webviews or devtools in packaged builds. */
export const webPreferences = (preloadPath: string, packaged: boolean) =>
  ({
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools: !packaged,
  }) as const;

/**
 * Content-Security-Policy for every response served from app://shikkha. Scripts only from the bundle; the API is reached through
 * the same origin (connect-src 'self'); school logos may come from https; no framing, no plugins, no form posts, no base tag.
 * 'unsafe-inline' is limited to styles (the UI uses style attributes).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export const isAppUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
};

/** The only IPC channel; its handler also verifies the sender frame (see isTrustedSender). */
export const IPC_CHANNELS = ['desktop:info'] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

export const isTrustedSender = (frameUrl: string | undefined): boolean => frameUrl !== undefined && isAppUrl(frameUrl);
