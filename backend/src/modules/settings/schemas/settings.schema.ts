/**
 * D-GATE Silver CRM canonical settings schemas entrypoint.
 * Transitional delegation to the established implementation.
 * Do not mount a second router or duplicate business logic here.
 * A physical split requires a separate tested source migration.
 */
export * from "../../customization/schemas/layouts.schema";
