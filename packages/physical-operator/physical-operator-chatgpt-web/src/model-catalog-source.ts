/** Map live ChatGPT Web picker choices into the shared model catalog. */

import type { CatalogModel, ModelCatalogSource } from '@deepseek-ai/dsh-model-catalog-local'
import type { ChatGptWebModelControls } from './model-controls.ts'

const PHYSICAL_OPERATOR_PROVIDER = 'dsh-physical-operator'

/**
 * Create the account-observed catalog source for one ChatGPT Web operator.
 * @param operatorId - configured physical-operator id used by the shared routing token.
 * @param controls - owner of live picker discovery and cancellation.
 * @returns a source whose refresh never substitutes an old private cache for a failed discovery.
 */
export function chatGptWebCatalogSource(
  operatorId: string,
  controls: Pick<ChatGptWebModelControls, 'refreshCatalog'>,
): ModelCatalogSource {
  return {
    id: `web:${operatorId}`,
    name: 'ChatGPT Web',
    provider: PHYSICAL_OPERATOR_PROVIDER,
    menuVisible: true,
    refresh: async (signal) => {
      const catalog = await controls.refreshCatalog(undefined, signal)
      return {
        available: true,
        models: catalog.models.map((choice): CatalogModel => ({
          id: choice.id,
          name: `ChatGPT Web · ${choice.label}`,
          provider: PHYSICAL_OPERATOR_PROVIDER,
          model: `${operatorId}:${choice.id}`,
          availability: 'available',
          evidence: 'web-picker',
          ...choice.reasoning === undefined ? {} : {
            reasoning: {
              efforts: choice.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.label })),
              ...choice.reasoning.defaultEffort === undefined ? {} : { defaultEffort: choice.reasoning.defaultEffort },
            },
          },
          ...choice.featuredRank === undefined ? {} : { featuredRank: choice.featuredRank },
        })),
      }
    },
  }
}
