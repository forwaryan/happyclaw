import { getChannelType } from './im-channel.js';

/**
 * A Web surface may inject input into an IM-owned session, but it never
 * changes transport ownership. Likewise, a later message observed through a
 * second IM connector cannot silently move an existing session to that Bot.
 */
export function resolveStickyChannelOwner(
  currentOwnerJid: string | null,
  incomingSourceJid: string | null,
): string | null {
  if (currentOwnerJid && getChannelType(currentOwnerJid)) {
    return currentOwnerJid;
  }
  return incomingSourceJid && getChannelType(incomingSourceJid)
    ? incomingSourceJid
    : null;
}
