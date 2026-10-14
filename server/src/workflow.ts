export type SheetStatus = 'draft' | 'submitted' | 'under_review' | 'returned' | 'approved' | 'published';
export type WorkflowAction = 'submit' | 'start_review' | 'approve' | 'return' | 'publish' | 'open_correction';

/** The only legal transitions. Everything else is rejected by the server. */
export const TRANSITIONS: Record<WorkflowAction, { from: SheetStatus[]; to: SheetStatus; permission: string; needsReason: boolean }> = {
  submit: { from: ['draft', 'returned'], to: 'submitted', permission: 'result.submit', needsReason: false },
  start_review: { from: ['submitted'], to: 'under_review', permission: 'result.review', needsReason: false },
  approve: { from: ['under_review'], to: 'approved', permission: 'result.review', needsReason: false },
  return: { from: ['under_review'], to: 'returned', permission: 'result.review', needsReason: true },
  publish: { from: ['approved'], to: 'published', permission: 'result.publish', needsReason: false },
  // Correction of a published result: starts a new revision, explicit reason required.
  open_correction: { from: ['published'], to: 'draft', permission: 'result.correct', needsReason: true },
};

export const EDITABLE: SheetStatus[] = ['draft', 'returned'];
