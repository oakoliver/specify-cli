/**
 * @oakoliver/specify-cli - Workflow Catalog
 *
 * Workflow catalog domain API (port of ``workflows/catalog/__init__.py``).
 * Re-exports the step-catalog compatibility names like upstream.
 *
 * @module workflows/catalog
 */

export {
  MAX_JSON_CATALOG_BYTES,
  WorkflowCatalog,
  WorkflowCatalogError,
  WorkflowRegistry,
  WorkflowRegistryError,
  WorkflowValidationError,
  type WorkflowCatalogEntry,
} from './domain.js';
export {
  StepCatalog,
  StepCatalogError,
  StepRegistry,
  StepValidationError,
  type StepCatalogEntry,
} from '../step/catalog/domain.js';
export { runWorkflowCatalogCommand } from './commands.js';
