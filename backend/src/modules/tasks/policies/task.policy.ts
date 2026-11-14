import type {TenantContext} from '../../../core/tenant/tenantContext';
import {requirePermission} from '../../../core/permissions/policies';
import {AppError} from '../../../core/errors/AppError';

export function allowTaskRead(t:TenantContext):void {
 requirePermission(t,'leads.read');
}
export function allowTaskWrite(t:TenantContext):void {
 if(t.role==='OWNER'||t.accessMode!=='FULL')throw AppError.forbidden();
 requirePermission(t,'leads.update');
}
