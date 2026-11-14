import type { Response } from 'express';
import { getDbPool } from '../../core/database/pool';
import { getTenantContext } from '../../core/tenant/tenantContext';
import { AppError } from '../../core/errors/AppError';
import { resolveAiConfiguration } from './ai.config';
import { readAiContentKey } from './ai.conversation.crypto';
import { aiDbId,aiConversationLimit,aiNoQuery,parseNewConversation } from './ai.conversation.schema';
import { type AiConversationDb,listAiConversations,getAiConversation,createAiConversation,listAiMessages } from './ai.conversation.repository';
export interface AiConversationDependencies {
  readonly connectionFactory?:()=>Promise<AiConversationDb>;
  readonly environment?:Readonly<Record<string,string|undefined>>;
}
export function createAiConversationService(deps:AiConversationDependencies={}){
  const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
  const env=deps.environment??process.env;
  function enabled(){
    const config=resolveAiConfiguration(env);
    if(config.state!=='ready')throw AppError.forbidden();
    return config;
  }
  async function read<T>(work:(db:AiConversationDb)=>Promise<T>):Promise<T>{
    const db=await factory();try{return await work(db);}finally{db.release();}
  }
  return Object.freeze({
    status(res:Response){
      getTenantContext(res);
      const config=resolveAiConfiguration(env);
      return {available:config.state==='ready',conversationStorageReady:
        typeof env.CRM_AI_CONTENT_KEY_B64==='string' && !!env.CRM_AI_CONTENT_KEY_B64};
    },
    async list(res:Response,query:Record<string,unknown>){
      enabled();const t=getTenantContext(res);const limit=aiConversationLimit(query);
      return read(db=>listAiConversations(db,t,limit));
    },
    async detail(res:Response,id:unknown,query:Record<string,unknown>){
      enabled();const t=getTenantContext(res);aiNoQuery(query);
      return read(db=>getAiConversation(db,t,aiDbId(id)));
    },
    async messages(res:Response,id:unknown,query:Record<string,unknown>){
      enabled();const t=getTenantContext(res);const conversationId=aiDbId(id);
      const limit=aiConversationLimit(query);
      const key=readAiContentKey(env.CRM_AI_CONTENT_KEY_B64);
      return read(db=>listAiMessages(db,t,conversationId,key,limit));
    },
    async create(res:Response,body:unknown,query:Record<string,unknown>){
      const config=enabled();const t=getTenantContext(res);
      if(t.role==='OWNER'||t.accessMode!=='FULL')throw AppError.forbidden();
      aiNoQuery(query);const input=parseNewConversation(body);
      // Ensure ciphertext storage is available before accepting new conversations.
      readAiContentKey(env.CRM_AI_CONTENT_KEY_B64);
      const db=await factory();
      try{
        await db.beginTransaction();
        try{
          const id=await createAiConversation(db,t,input.assistantId,input.title,config.model);
          await db.commit();return {id};
        }catch(error){await db.rollback();throw error;}
      }finally{db.release();}
    }
  });
}
