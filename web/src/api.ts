export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// Browser builds use same-origin /api. Branded native clients (future) set VITE_API_BASE_URL at build time.
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
};

export interface Membership {
  school_id: string;
  role: string;
  school_name: string;
}
export interface Branding {
  display_name: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
}
export interface EntitlementInfo {
  level: 'full' | 'grace' | 'read_only' | 'blocked';
  status: string;
  warning: { code: string; message: string } | null;
  full_access_until: string;
  read_only_until: string;
  retention_until: string;
}
export interface Session {
  user: { id: string; email: string; full_name: string; language: 'bn' | 'en'; credential_change_required?: boolean };
  school: { id: string; slug: string; name: string };
  active_school_id: string | null;
  roles: string[];
  permissions: string[];
  memberships: Membership[];
  entitlement: EntitlementInfo;
  branding: Branding | null;
}
