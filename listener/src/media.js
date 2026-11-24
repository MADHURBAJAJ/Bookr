// Which WhatsApp messages the listener keeps, decided before anything is downloaded: a photo, or a PDF/JPEG/PNG sent
// as a document, in a group Bookr reads, up to 10 MB. Everything else (private chats, other groups, text, voice notes,
// videos, stickers) is skipped unseen: not downloaded, not stored, not logged beyond a count.

import { isJidGroup, normalizeMessageContent } from 'baileys';

export const MAX_BYTES = 10 * 1024 * 1024;
const DOC_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

/** The digits of a phone-number id (919800000000@s.whatsapp.net or …:3@s.whatsapp.net); null for other ids. */
export function phoneOf(jid) {
  const m = /^(\d{6,20})(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid ?? ''));
  return m ? m[1] : null;
}

/**
 * What to do with one message: { keep: false, why } or { keep: true, meta, size }.
 * `reads(groupId)` says whether the group is read; `me` is the linked number's ids ({ id, lid }).
 */
export function pick(msg, { reads, me = {}, groupName = () => undefined }) {
  const key = msg?.key ?? {};
  const group = key.remoteJid;
  if (!group || !isJidGroup(group)) return { keep: false, why: 'not a group' };
  if (!reads(group)) return { keep: false, why: 'group not read' };
  if (!key.id) return { keep: false, why: 'no id' };
  const content = normalizeMessageContent(msg.message);
  if (!content) return { keep: false, why: 'empty' };

  let media;
  let mediaType;
  if (content.imageMessage) {
    media = content.imageMessage;
    mediaType = 'image';
  } else if (content.documentMessage && DOC_TYPES.has(String(content.documentMessage.mimetype ?? '').split(';')[0].trim().toLowerCase())) {
    media = content.documentMessage;
    mediaType = 'document';
  } else {
    return { keep: false, why: 'not a photo or PDF' };
  }
  const size = Number(media.fileLength ?? 0);
  if (size > MAX_BYTES) return { keep: false, why: 'larger than 10 MB' };

  // The sender: in groups WhatsApp may give a private id (…@lid) with the phone number alongside, or no number at all.
  const senderId = key.fromMe ? me.id : key.participant;
  const senderNumber = phoneOf(senderId) ?? phoneOf(key.participantAlt) ?? phoneOf(key.participantPn) ?? undefined;
  const ts = Number(msg.messageTimestamp ?? 0);
  const meta = {
    messageId: key.id,
    groupId: group,
    groupName: groupName(group) || undefined,
    senderNumber,
    senderName: (key.fromMe ? me.name : msg.pushName) || undefined,
    sentAt: ts > 0 ? ts * 1000 : Date.now(),
    mediaType,
    caption: media.caption?.trim() ? String(media.caption).slice(0, 2000) : undefined,
    // A bill sent as a reply to its UPI photo (or the other way round): the strongest sign of a pair.
    replyTo: media.contextInfo?.stanzaId || undefined,
  };
  return { keep: true, meta, size };
}
