import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { AppError } from '../../core/errors/AppError';

/** Requires independent random 32-byte key. This key must never be logged or sent to a browser. */
export function readAiContentKey(base64: string | undefined): Buffer {
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    throw new Error('AI_CONTENT_KEY_NOT_CONFIGURED');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64)
    throw new Error('AI_CONTENT_KEY_NOT_CONFIGURED');
  return key;
}
function aad(companyId: string, conversationId: string): Buffer {
  if (!/^[1-9][0-9]{0,19}$/.test(companyId) || !/^[1-9][0-9]{0,19}$/.test(conversationId))
    throw AppError.forbidden();
  return Buffer.from(`dgate.crm.ai.v1|${companyId}|${conversationId}`, 'utf8');
}
/** Wire format: version(1 byte) | nonce(12) | GCM tag(16) | ciphertext. */
export function encryptAiMessage(text: string, key: Buffer, companyId: string, conversationId: string): Buffer {
  if (typeof text !== 'string' || !text || text.length > 12000 || Buffer.byteLength(text, 'utf8') > 32768)
    throw new Error('AI_MESSAGE_TOO_LARGE');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(companyId, conversationId));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}
export function decryptAiMessage(blob: Buffer, key: Buffer, companyId: string, conversationId: string): string {
  if (!Buffer.isBuffer(blob) || blob.length < 30 || blob.length > 32800 || blob[0] !== 1)
    throw new Error('AI_MESSAGE_INVALID_CIPHERTEXT');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
    decipher.setAAD(aad(companyId, conversationId));
    decipher.setAuthTag(blob.subarray(13, 29));
    const plain = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
    if (plain.byteLength > 32768) throw new Error('AI_MESSAGE_INVALID_CIPHERTEXT');
    return plain.toString('utf8');
  } catch {
    throw new Error('AI_MESSAGE_INVALID_CIPHERTEXT');
  }
}
