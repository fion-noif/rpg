// Shared between the Server Actions in ./actions.ts and the small client components that
// render their result. Kept in its own module so ./actions.ts can stay a pure `'use server'`
// file whose every export is a callable action.

/**
 * The result of an action that mints a one-time password. `password` is present exactly once,
 * on the render immediately after the action ran — only the scrypt hash is stored, so it is
 * never recoverable afterwards. Same discipline as LinkState in ../events/[eventId]/types.ts.
 */
export interface TempPasswordState {
  password?: string;
  username?: string;
  name?: string;
  error?: string;
}

export const emptyTempPasswordState: TempPasswordState = {};

/** Result of the self-service password change. */
export interface AccountState {
  changed?: boolean;
  error?: string;
}

export const emptyAccountState: AccountState = {};
