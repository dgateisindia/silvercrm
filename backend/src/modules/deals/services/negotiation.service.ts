/**
 * D-GATE Silver CRM canonical deals services entrypoint.
 * Transitional delegation to the established implementation.
 * Do not mount a second router or duplicate business logic here.
 * A physical split requires a separate tested source migration.
 */
export * from "../../conversion/services/conversion.service";
