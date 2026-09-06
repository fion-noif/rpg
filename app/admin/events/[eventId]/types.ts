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
