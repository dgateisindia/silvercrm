export type AiProvider = 'gemini' | 'deepseek' | 'openai';

export type AiPurpose =
  | 'lead_summary'
  | 'followup_draft'
  | 'email_draft'
  | 'chat';

export type AiRole = 'OWNER' | 'MANAGER' | 'EMPLOYEE';

export interface TrustedAiContext {
  readonly companyId: string;
  readonly actorUserId: string;
  readonly role: AiRole;
  readonly accessMode: 'FULL' | 'READ_ONLY';
}

export interface AiInput {
  readonly purpose: AiPurpose;
  readonly prompt: string;
}

export interface AiGateway {
  generate(request: Readonly<{
    provider: AiProvider;
    model: string;
    apiKey: string;
    companyId: string;
    actorUserId: string;
    purpose: AiPurpose;
    prompt: string;
  }>): Promise<{ readonly text: string }>;
}
