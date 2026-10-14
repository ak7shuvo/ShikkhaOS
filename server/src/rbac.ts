import type { Db } from './db.js';

/** Every permission string used by route guards. The authoritative role→permission
 * mapping lives in the database (role_permissions) and is loaded at startup. */
export const PERMISSIONS = [
  'platform.schools.manage',
  'platform.licenses.manage',
  'school.view',
  'school.manage',
  'members.manage',
  'academic.view',
  'academic.manage',
  'students.view',
  'exams.manage',
  'marks.enter',
  'result.view',
  'result.submit',
  'result.review',
  'result.publish',
  'result.correct',
  'guardian.portal',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SCHOOL_ROLES = ['school_admin', 'principal', 'exam_controller', 'teacher', 'guardian'] as const;
/** Roles assignable through the members API. `student` is reserved and not assignable yet. */
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

export type RolePermissionMap = Map<string, Set<string>>;

export async function loadRolePermissions(pool: Db): Promise<RolePermissionMap> {
  const { rows } = await pool.query<{ role_key: string; permission: string }>('SELECT role_key, permission FROM role_permissions');
  const map: RolePermissionMap = new Map();
  for (const r of rows) {
    if (!map.has(r.role_key)) map.set(r.role_key, new Set());
    map.get(r.role_key)!.add(r.permission);
  }
  return map;
}

export function permissionsFor(map: RolePermissionMap, roles: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of roles) for (const p of map.get(r) ?? []) out.add(p);
  return out;
}
