/** Choices observed in the plugin's target browser, never inferred from another browser. */
export interface WebModelChoice {
  readonly label: string
  readonly available: boolean
  readonly selected: boolean
}
export interface WebEffortChoice {
  readonly label: string
  readonly id?: string
  readonly index?: number
  readonly available: boolean
  readonly selected: boolean
}
export interface WebModelCatalog {
  readonly formatVersion: 1
  readonly observedAt: string
  readonly browser: {
    readonly kind: 'ego-lite'
    readonly spaceId: number
    readonly pageLabel: string
  }
  readonly models: readonly WebModelChoice[]
  /** Efforts belong to this model, not to every item in models. */
  readonly effortModelLabel: string
  readonly efforts: readonly WebEffortChoice[]
  readonly selected: {
    readonly modelLabel: string
    readonly effortLabel?: string
    readonly effortId?: string
  }
}
export interface WebModelCatalogRefreshInput {
  /** Omitted/empty means inspect the target page's current model. */
  readonly modelLabel?: string
}
export interface WebModelCatalogApi {
  /** Reads the last snapshot; never opens a page. */
  read(): Promise<WebModelCatalog | undefined>
  /** Explicit no-prompt inspection; temporary selections must be restored. */
  refresh(input: WebModelCatalogRefreshInput): Promise<WebModelCatalog>
}
