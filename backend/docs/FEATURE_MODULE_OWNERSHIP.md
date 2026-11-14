# D-GATE CRM Feature Module Ownership (build-stage)

The six originally empty folders now provide typed, canonical feature entrypoints backed by existing working modules. **No physical business-logic split is performed in this batch.** No duplicate API router is mounted; all existing endpoints remain in their original protected route registry.

| Feature folder | Current authoritative code | Notes |
|---|---|---|
| accounts | customers | Customer module currently combines account + contact operations |
| contacts | customers | Sharing repository/service until a separately tested split |
| calendar | workforce | Leave and coverage remain alongside calendar operations |
| deals | sales + conversion | Deals, quotations and negotiations retain original ownership |
| employees | staff_admin + invitations | Invitation/activation remains gated by Platform/Clerk approval |
| settings | customization | Layouts, views, picklists and custom fields stay intact |

Architecture test verifies that facade-exported router factories are identical to the original implementations. The TypeScript build validates every bridged import. **A physical move or domain-specific API decomposition is not claimed**; choose that as a separately tested refactor only if needed. Never mount both old and facade router factories. Database `dgate_crm_fresh` is not changed.
