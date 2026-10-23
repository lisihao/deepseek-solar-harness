/** Trusted JavaScript integration surface; never a model-visible script runner. */
export { WebController, type WebControllerOptions } from './controller.js'
export { WebRunStore, type WebRunRecord, type WebRunRequest, type WebRunResource } from './store.js'
export { EgoWebAdapter, type EgoWebAdapterOptions } from './ego-adapter.js'
export { WebBrowserError, type WebBrowserAdapter } from './browser-contract.js'
export { runEgoProcess } from './process.js'
export { EgoProcessError, type EgoProcessRequest, type EgoProcessResult } from './process-contract.js'
