import { StorageError } from './storage.errors.js';
import type { StorageProvider } from './storage.provider.js';
import type { StorageProviderName } from './storage.types.js';

export class StorageProviderRegistry {
  private readonly providers = new Map<StorageProviderName, StorageProvider>();

  register(provider: StorageProvider): this {
    this.providers.set(provider.name, provider);
    return this;
  }

  has(name: StorageProviderName): boolean {
    return this.providers.has(name);
  }

  get(name: StorageProviderName): StorageProvider {
    const provider = this.providers.get(name);

    if (!provider) {
      throw new StorageError(
        `Storage provider "${name}" is not registered`,
        'STORAGE_PROVIDER_NOT_FOUND',
      );
    }

    return provider;
  }

  names(): StorageProviderName[] {
    return [...this.providers.keys()];
  }
}
