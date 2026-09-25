import { createContext, useContext } from 'react'
import type { MnemonTranslate } from './locales.ts'
import sidebarCss from './MnemonSidebarView.module.css'

export type MnemonViewSurface = 'buildin' | 'sidebar'

type AppearanceSlot =
  | 'shell'
  | 'masthead'
  | 'brand'
  | 'headerActions'
  | 'workspacePicker'
  | 'statusCluster'
  | 'workspaceMismatch'
  | 'topNavigation'
  | 'nav'
  | 'navGroup'
  | 'memoryWorkspace'
  | 'memoryNavigation'
  | 'memoryTabs'
  | 'memoryWriteButton'
  | 'bodyCardHeader'
  | 'bodyDirectoryActions'
  | 'bodyCardIdentity'
  | 'bodyCardMeta'
  | 'bodyCardFooter'
  | 'bodyCardStats'
  | 'itemActionButton'
  | 'itemEditAction'
  | 'itemDangerAction'
  | 'modalBackdrop'
  | 'modal'
  | 'canvas'
  | 'pageHeader'
  | 'inspectorGlyph'

export interface MnemonViewAppearance {
  surface: MnemonViewSurface
  title: string
  showLogo: boolean
  showTelemetry: boolean
  showNavigationGlyphs: boolean
  showNavigationDetails: boolean
  showNavigationDividers: boolean
  showSpaceSummary: boolean
  classes: Partial<Record<AppearanceSlot, string | undefined>>
}

const buildinAppearance: MnemonViewAppearance = {
  surface: 'buildin',
  title: 'Mnemon',
  showLogo: true,
  showTelemetry: true,
  showNavigationGlyphs: true,
  showNavigationDetails: true,
  showNavigationDividers: true,
  showSpaceSummary: true,
  classes: {},
}

/** Appearance is a surface concern; every data flow and workspace action stays shared. */
export function resolveMnemonViewAppearance(surface: MnemonViewSurface, t: MnemonTranslate): MnemonViewAppearance {
  if (surface === 'buildin') return buildinAppearance
  return {
    surface: 'sidebar',
    title: t('tab.label'),
    showLogo: false,
    showTelemetry: false,
    showNavigationGlyphs: false,
    showNavigationDetails: false,
    showNavigationDividers: false,
    showSpaceSummary: false,
    classes: {
      shell: sidebarCss.shell,
      masthead: sidebarCss.masthead,
      brand: sidebarCss.brand,
      headerActions: sidebarCss.headerActions,
      workspacePicker: sidebarCss.workspacePicker,
      statusCluster: sidebarCss.statusCluster,
      workspaceMismatch: sidebarCss.workspaceMismatch,
      topNavigation: sidebarCss.topNavigation,
      nav: sidebarCss.nav,
      navGroup: sidebarCss.navGroup,
      memoryWorkspace: sidebarCss.memoryWorkspace,
      memoryNavigation: sidebarCss.memoryNavigation,
      memoryTabs: sidebarCss.memoryTabs,
      memoryWriteButton: sidebarCss.memoryWriteButton,
      bodyCardHeader: sidebarCss.bodyCardHeader,
      bodyDirectoryActions: sidebarCss.bodyDirectoryActions,
      bodyCardIdentity: sidebarCss.bodyCardIdentity,
      bodyCardMeta: sidebarCss.bodyCardMeta,
      bodyCardFooter: sidebarCss.bodyCardFooter,
      bodyCardStats: sidebarCss.bodyCardStats,
      itemActionButton: sidebarCss.itemActionButton,
      itemEditAction: sidebarCss.itemEditAction,
      itemDangerAction: sidebarCss.itemDangerAction,
      modalBackdrop: sidebarCss.modalBackdrop,
      modal: sidebarCss.modal,
      canvas: sidebarCss.canvas,
      pageHeader: sidebarCss.pageHeader,
      inspectorGlyph: sidebarCss.inspectorGlyph,
    },
  }
}

const AppearanceContext = createContext<MnemonViewAppearance>(buildinAppearance)

export const MnemonViewAppearanceProvider = AppearanceContext.Provider

export function useMnemonViewAppearance(): MnemonViewAppearance {
  return useContext(AppearanceContext)
}

export function appearanceClass(base: string | undefined, variant: string | undefined): string {
  return [base, variant].filter((value): value is string => value !== undefined && value !== '').join(' ')
}
