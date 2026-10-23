import {definition as originalDefinition} from 'dsh-mnemon-provider-hindsight';
import {defineMemorySpaceProvider, defineMemorySpaceProviderDefinition, type MemoryProviderAdapter} from 'dsh-mnemon-source-memory-spaces/provider-sdk';

/** A separate adapter object keeps driver behavior, without a false score-scale promise. */
export function createNativeScoreAdapter(original: MemoryProviderAdapter): MemoryProviderAdapter {
  return {
    id: original.id,
    status: original.status.bind(original),
    search: original.search.bind(original),
    graph: original.graph.bind(original),
    list: original.list.bind(original),
    remember: original.remember.bind(original),
    ...(original.discover ? {discover: original.discover.bind(original)} : {}),
    ...(original.invalidateStatus ? {invalidateStatus: original.invalidateStatus.bind(original)} : {}),
    ...(original.metadataSample ? {metadataSample: original.metadataSample.bind(original)} : {}),
    ...(original.entityIndex ? {entityIndex: original.entityIndex.bind(original)} : {}),
    ...(original.rememberMany ? {rememberMany: original.rememberMany.bind(original)} : {}),
    ...(original.get ? {get: original.get.bind(original)} : {}),
    ...(original.related ? {related: original.related.bind(original)} : {}),
    ...(original.link ? {link: original.link.bind(original)} : {}),
    ...(original.forget ? {forget: original.forget.bind(original)} : {}),
    ...(original.dispose ? {dispose: original.dispose.bind(original)} : {}),
  };
}

export const definition = defineMemorySpaceProviderDefinition({
  manifest: {...originalDefinition.manifest, packageName:'@lisihao/dsh-solar-hindsight-score-adapter', version:'0.0.0', scoreSemantics:'provider-native'},
  create: context => createNativeScoreAdapter(originalDefinition.create(context)),
});

export default defineMemorySpaceProvider({id:'hindsight', apply(ctx, host) {host.install(ctx, definition);}});
