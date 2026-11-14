/**
 * D-GATE Silver CRM canonical settings routes entrypoint.
 * Transitional delegation to the established implementation.
 * Do not mount a second router or duplicate business logic here.
 * A physical split requires a separate tested source migration.
 */
export * from "../../customization/routes/saved_views.routes";
