/**
 * Host half of the subscription hub bundle.
 *
 * The hub is a browser settings contribution only. Keeping this entry inert
 * avoids creating a host service, reading credentials, or starting RPC work.
 */
export const name = 'subscription-hub'

export function apply(): void {}
