/**
 * D-GATE Silver CRM canonical calendar routes entrypoint.
 * Transitional delegation to the established implementation.
 * Do not mount a second router or duplicate business logic here.
 * A physical split requires a separate tested source migration.
 */
export * from "../../workforce/workforce.routes";
