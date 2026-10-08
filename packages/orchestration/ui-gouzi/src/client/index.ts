/** Browser half: sidebar entry, Settings management, and the session-scoped kennel room. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle as ApiConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { encodeKennelMessage } from '../recipient-message.ts'
import { GouziSettings, type GouziSettingsInjected } from './GouziPanel.tsx'
import { KennelEntry } from './KennelEntry.tsx'
import { KENNEL_PRESET, openKennel } from './kennel.ts'
import { KennelRoomAside, KennelRoomComposer, KennelRoomContent, KennelRoomHeader, type KennelRoomInjected } from './KennelRoom.tsx'
import { loadKennelRoom, readKennelEvidence } from './room-api.ts'
import { KennelRoomSource } from './room-source.ts'
import { createKennelRoomStore } from './room-store.ts'

export { controlGouzi, GouziRequestError, loadGouzi, type BrowserRequest } from './api.ts'
export { GouziAvatarImage } from './avatars.tsx'
export { GouziManager, GouziSettings, type GouziFolders, type GouziSettingsInjected } from './GouziPanel.tsx'
export { KennelEntry, type KennelEntryProps } from './KennelEntry.tsx'
export { KENNEL_PRESET, openKennel, type KennelServices } from './kennel.ts'

/** Browser services required by management and the room's scoped conversation actions. */
export const inject = ['slots', 'connection', 'workspaces', 'sessions', 'conversation']

/**
 * Register the sidebar, Settings, and four kennel-only room slots.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const { api } = ctx.get('connection') as unknown as ApiConnectionHandle
  const { workspaces, sessions } = ctx
  const roomStore = createKennelRoomStore()
  const sources = new Map<SessionId, KennelRoomSource>()
  const freshReads = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  let disposed = false

  function liveScope(id: SessionId | undefined) {
    if (disposed) throw new Error('狗窝聊天室已卸载，请重新打开。')
    if (id === undefined) throw new Error('狗窝会话尚未创建。')
    const scope = sessions.scope(id)
    const binding = sessions.binding(id)
    if (!scope || !binding) throw new Error('狗窝会话已不存在，请重新打开。')
    if (binding.session.getSnapshot().removed) throw new Error('狗窝会话已移除，不能继续操作。')
    return scope
  }

  function scopedConversation(id: SessionId) {
    const conversation = liveScope(id).get('conversation')
    if (conversation === undefined) throw new Error('狗窝会话的消息服务不可用，请重新打开。')
    return conversation
  }

  function sendScope(id: SessionId) {
    const conversation = scopedConversation(id)
    const block = ctx.conversation.blocks.storeFor(id).getSnapshot()
    if (block) throw new Error(block.reason)
    return conversation
  }

  async function ownedRead<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    controllers.add(controller)
    const pending = read(controller.signal)
    freshReads.add(pending)
    try { return await pending }
    finally { controllers.delete(controller); freshReads.delete(pending) }
  }

  function sourceFor(id: SessionId): KennelRoomSource {
    liveScope(id)
    let source = sources.get(id)
    if (!source) {
      source = new KennelRoomSource(id, (signal) => {
        liveScope(id)
        return loadKennelRoom(connection.request, id, signal)
      })
      sources.set(id, source)
    }
    return source
  }

  const roomInject = (id: SessionId | undefined): KennelRoomInjected => {
    if (id === undefined) throw new Error('狗窝会话尚未创建。')
    liveScope(id)
    const source = sourceFor(id)
    return {
      hooks: { room: source },
      reload: async () => { liveScope(id); await source.reload(); liveScope(id) },
      send: async ({ text, recipient }) => {
        sendScope(id)
        const target = recipient === null ? null : { ...recipient }
        if (target !== null) {
          const room = await ownedRead(signal => loadKennelRoom(connection.request, id, signal))
          liveScope(id)
          const member = room.dashboard.members.find(m => m.gouziId === target.gouziId)
          if (!member || member.membership !== 'enabled') throw new Error('原发送对象当前不可用；目标已保留。')
          const execution = room.execution.find(e => e.gouziId === target.gouziId)
          if (!execution || execution.generation !== target.generation) throw new Error('执行实例已变化，请重新点名；原目标已保留。')
          if (!execution.operators.some(o => o.available)) throw new Error('原发送对象没有可用执行入口；目标已保留。')
        }
        await sendScope(id).send(encodeKennelMessage(text, target))
      },
      loadOlder: async () => { await scopedConversation(id).loadOlder() },
      readEvidence: async (runId, ref) => {
        liveScope(id)
        const evidence = await ownedRead(signal => readKennelEvidence(connection.request, id, runId, ref, signal))
        liveScope(id)
        return evidence
      },
    }
  }

  ctx.effect(() => async () => {
    disposed = true
    for (const controller of controllers) controller.abort()
    // Readers deliver their own errors; teardown waits for settlement without replacing them.
    await Promise.all([Promise.allSettled([...freshReads]), ...[...sources.values()].map(source => source.dispose())])
    sources.clear()
  }, 'kennel room sources')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'kennel', order: 90, label: '狗窝',
    inject: () => ({ request: connection.request, open: () => openKennel({ sessions, workspaces, api }) }),
  }, KennelEntry))

  ctx.slots.inject('conversation.room.header', () => ctx.slots.register({
    name: 'conversation.room.header', store: roomStore,
    select: owner => owner.agentPreset === KENNEL_PRESET ? true : null,
    inject: roomInject,
  }, KennelRoomHeader))
  ctx.slots.inject('conversation.room.content', () => ctx.slots.register({
    name: 'conversation.room.content', store: roomStore,
    select: owner => owner.agentPreset === KENNEL_PRESET ? true : null,
    inject: roomInject,
  }, KennelRoomContent))
  ctx.slots.inject('conversation.room.aside', () => ctx.slots.register({
    name: 'conversation.room.aside', store: roomStore,
    select: owner => owner.agentPreset === KENNEL_PRESET ? true : null,
    inject: roomInject,
  }, KennelRoomAside))

  ctx.slots.inject('conversation.room.composer', () => ctx.slots.register({
    name: 'conversation.room.composer', store: roomStore,
    select: owner => owner.agentPreset === KENNEL_PRESET && !owner.inert && !owner.blocked ? true : null,
    inject: roomInject,
  }, KennelRoomComposer))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'gouzi', order: 38, label: () => '狗子',
    inject: (): GouziSettingsInjected => ({ request: connection.request, folders: workspaces }),
  }, GouziSettings))
}
