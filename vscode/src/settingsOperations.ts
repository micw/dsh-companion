/** Settings operations use existing canonical DSH methods, never Session submission. */
import type { DshClient } from './dshClient';
import type { SettingsRequest } from './settingsProtocol';
export type SettingsClient = Pick<DshClient, 'providerSettings' | 'searchSettings' | 'updateProviderSettings'
  | 'testProviderConnection' | 'createProviderInstance' | 'deleteProviderInstance' | 'setProviderModelsEnabled'>;
export async function executeSettingsOperation(
  client: SettingsClient, operation: SettingsRequest['operation'], confirmRemoval: (name: string) => Promise<boolean>,
): Promise<object> {
  switch (operation.kind) {
    case 'load': {
      const [models, search] = await Promise.all([client.providerSettings(), client.searchSettings({ kind: 'list' })]);
      return { models, search };
    }
    case 'status': return { search: await client.searchSettings({ kind: 'list' }) };
    case 'search': {
      if (operation.command.kind === 'remove' && !await confirmRemoval('this search access')) return { cancelled: true };
      return { search: await client.searchSettings(operation.command) };
    }
    case 'saveProvider': {
      let models = await client.updateProviderSettings(operation);
      if (operation.test) models = (await client.testProviderConnection(operation.provider)).snapshot;
      return { models };
    }
    case 'createProvider': return { models: await client.createProviderInstance(operation.family, operation) };
    case 'deleteProvider': {
      if (!await confirmRemoval(operation.displayName)) return { cancelled: true };
      return { models: await client.deleteProviderInstance(operation.family, operation.instance, operation.provider) };
    }
    case 'models': return { models: await client.setProviderModelsEnabled(operation.provider, operation.models, operation.enabled, operation.revision) };
  }
}
