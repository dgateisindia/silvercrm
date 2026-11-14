# Silver CRM AI Generation â€” Disabled by default

Routes: `POST /api/v1/crm/ai/conversations/:conversationId/generate`

## Critical operational controls
- Do **not** enable in production or staging until an authorized backend operator verifies Clerk/Platform membership behavior, test migrations, model rate cards, provider keys, prompt handling, and isolated MariaDB results.
- Configuration requires all of: `CRM_AI_ENABLED=true`, `CRM_AI_GENERATION_ENABLED=true`, `CRM_AI_PROVIDER`, `CRM_AI_MODEL`, correct `CRM_*_API_KEY`, random `CRM_AI_CONTENT_KEY_B64`, `CRM_AI_REQUEST_RESERVE_USD`, `CRM_AI_DAILY_USER_LIMIT`, `CRM_AI_DAILY_COMPANY_LIMIT`.
- A matching, enabled `crm_ai_assistants` record and an `crm_ai_policies` record with `read_only=1`, `allow_external_knowledge=0`, and non-NULL `max_monthly_cost` (interpreted as **USD**) are required for each company assistant. The schema has no policy currency field: confirm that convention before enabling.
- The user must have active company `FULL` access; only Manager and Employee may generate; each conversation belongs to its requesting user.
- Existing GPT/Gemini/DeepSeek HTTP adapters are used, but generation is OFF unless explicitly enabled. Inputs are user-entered text only; no auto-fetch of CRM rows, tools, web, or attached knowledge is enabled.
- Each attempted call reserves a fixed **estimated** USD amount, persisted before the provider request. Counts and the modeled monthly budget are enforced under a company-row transaction lock. This is a **conservative planning estimate**, NOT verified billing, not a hard financial spend cap; actual provider token usage/cost is not available from the current gateway. Configure the reservation sufficiently high for the model and request limits; monitor actual provider billing independently.
- Every attempted run consumes its reservation even on provider error, to fail conservatively. Rows stranded in `running` after a process crash conservatively block a conversation; there is no automatic retry/cleaner in this batch. Requires operational recovery policy.
- Prompts and answers are stored encrypted at rest with AES-256-GCM and never written to audit details. The response includes the AI generated text and opaque record IDs, not secrets.
- This is a **build-only batch**. Full MariaDB, HTTP, concurrency, fault injection, revocation, privacy and provider acceptance tests have not been completed. Use a scratch QA DB. Never change `dgate_crm_fresh` with test fixtures.
