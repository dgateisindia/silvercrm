import { randomBytes } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { aiDbId,aiConversationLimit,parseNewConversation } from '../../src/modules/ai/ai.conversation.schema';
import { readAiContentKey,encryptAiMessage,decryptAiMessage } from '../../src/modules/ai/ai.conversation.crypto';

describe('AI conversation boundary',()=>{
  it('validates database identities and rejects unsafe parameters',()=>{
    expect(aiDbId('123')).toBe('123');
    expect(()=>aiDbId('0')).toThrow();
    expect(()=>aiDbId('1 OR 1=1')).toThrow();
    expect(()=>aiConversationLimit({limit:'51'})).toThrow();
    expect(()=>aiConversationLimit({companyId:'2'})).toThrow();
    expect(aiConversationLimit({})).toBe(20);
  });
  it('requires assistant ownership to be resolved by the repository',()=>{
    expect(parseNewConversation({assistantId:'8',title:'Sales follow-up'})).toEqual({assistantId:'8',title:'Sales follow-up'});
    expect(()=>parseNewConversation({assistantId:'8',companyId:'7'})).toThrow();
    expect(()=>parseNewConversation({assistantId:'8',title:'a'.repeat(121)})).toThrow();
  });
  it('uses tenant-bound AES-GCM for messages',()=>{
    const rawKey=randomBytes(32);
    const key=readAiContentKey(rawKey.toString('base64'));
    const blob=encryptAiMessage('Only the assigned user may read this',key,'1','2');
    expect(blob.toString('utf8')).not.toContain('assigned user');
    expect(decryptAiMessage(blob,key,'1','2')).toContain('assigned user');
    expect(()=>decryptAiMessage(blob,key,'2','2')).toThrow();
    expect(()=>decryptAiMessage(blob,key,'1','3')).toThrow();
  });
  it('rejects invalid keys, ciphertext changes and oversized input',()=>{
    expect(()=>readAiContentKey('test')).toThrow();
    const key=readAiContentKey(randomBytes(32).toString('base64'));
    const blob=encryptAiMessage('hello',key,'1','2');
    blob[blob.length-1] ^= 1;
    expect(()=>decryptAiMessage(blob,key,'1','2')).toThrow();
    expect(()=>encryptAiMessage('x'.repeat(12001),key,'1','2')).toThrow();
  });
});
