/**
 * Node-side package entry; behavior lives in the browser client bundle.
 * @module @deepseek-ai/dsh-client-ui-task-template
 */

/** Cordis node-side function-plugin name. */
export const name = 'client-ui-task-template'
/** Node-side service requirements; this half has no runtime behavior. */
export const inject: string[] = []
/** @returns nothing; the node half is intentionally empty. */
export function apply(): void {}
