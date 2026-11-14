import { describe, it, expect } from 'vitest';

import { createCustomerRouter as originalCustomers } from '../../src/modules/customers/routes/customer.routes';
import { createCustomerRouter as viaAccounts } from '../../src/modules/accounts/routes/account.routes';
import { createCustomerRouter as viaContacts } from '../../src/modules/contacts/routes/contact.routes';
import { createWorkforceRouter as originalWorkforce } from '../../src/modules/workforce/workforce.routes';
import { createWorkforceRouter as viaCalendar } from '../../src/modules/calendar/routes/calendar.routes';
import { createSalesRouter as originalSales } from '../../src/modules/sales/routes/sales.routes';
import { createSalesRouter as viaDeals } from '../../src/modules/deals/routes/deal.routes';
import { createStaffAdminRouter as originalStaffAdmin } from '../../src/modules/staff_admin/staff_admin.routes';
import { createStaffAdminRouter as viaEmployees } from '../../src/modules/employees/routes/employee.routes';
import { createLayoutRouter as originalLayout } from '../../src/modules/customization/routes/layouts.routes';
import { createLayoutRouter as viaSettings } from '../../src/modules/settings/routes/settings.routes';

/** The feature entrypoints must reuse the *same* route factory, not a competing implementation. */
describe('Silver CRM six feature compatibility entrypoints', () => {
  it('accounts and contacts use the existing customer implementation', () => {
    expect(viaAccounts).toBe(originalCustomers);
    expect(viaContacts).toBe(originalCustomers);
  });
  it('calendar delegates to the existing workforce module', () => {
    expect(viaCalendar).toBe(originalWorkforce);
  });
  it('deals delegates to the existing sales module', () => {
    expect(viaDeals).toBe(originalSales);
  });
  it('employees delegate to the existing staff admin module', () => {
    expect(viaEmployees).toBe(originalStaffAdmin);
  });
  it('settings delegate to the existing layout/customization module', () => {
    expect(viaSettings).toBe(originalLayout);
  });
});
