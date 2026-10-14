import type { Tx } from './db.js';

export async function audit(
  tx: Tx,
  e: { schoolId: string | null; actorUserId: string | null; action: string; entityType: string; entityId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (school_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.schoolId, e.actorUserId, e.action, e.entityType, e.entityId ?? null, JSON.stringify(e.metadata ?? {})],
  );
}
