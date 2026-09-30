/** Compatibility name for Composer and existing callers. This is NOT a second store.
 * Desktop domain state and bounded network DTOs live in the same runtime store.
 * New shared components should use useRuntimeStore and its source-aware selectors.
 */
export { useRuntimeStore as useWebWorkspaceStore } from './runtimeStore';
