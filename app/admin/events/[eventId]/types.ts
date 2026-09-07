// Shared between the Server Actions in ./actions.ts and the small client components that
// render their result. Kept in its own module so ./actions.ts can stay a pure `'use server'`
// file whose every export is a callable action.

/**
 * The result of an action that mints a magic link. `link` is present exactly once, on the
 * render immediately after the action ran — the token is stored only as a hash, so it is
 * never recoverable afterwards.
 */
export interface LinkState {
  link?: string;
  name?: string;
  /** True when the person was already on the event, so there is no link to show. */
  existing?: boolean;
  error?: string;
}

export const emptyLinkState: LinkState = {};

/**
 * The result of assigning from a customer's row, which may also have put the person on the
 * event and therefore minted a link.
 *
 * Extends `LinkState` rather than reusing it wholesale because `existing` is not the right
 * word here — its copy tells the manager to use "Rotate link", which is advice about adding
 * a worker, not about assigning one. The panel says "already recording for this customer"
 * instead.
 */
export interface AssignState extends LinkState {
  /** Customer display name, set on success, so the panel can confirm what happened. */
  assignedTo?: string;
}

export const emptyAssignState: AssignState = {};

/** Which panel of the event page is showing. `customers` is the default and is never
 *  written into the URL, so a clean `/admin/events/3` stays clean. */
export type Tab = 'customers' | 'workers';

/**
 * One person in the "worked before" picker. Lives here rather than in AddWorkerForm now
 * that both that form and the customers-tab assign panel need it.
 */
export interface StaffOption {
  id: number;
  name: string;
  language: 'en' | 'es';
  lastEventCode: string | null;
  eventCount: number;
}

/** Human labels for `charge_batches.status`. Shared by the customers table and the close page. */
export const BATCH_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  POSTED: 'Posted',
  POST_FAILED: 'Post failed',
};
