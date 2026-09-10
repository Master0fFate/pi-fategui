export interface BackgroundImage {
  image: Blob;
  name: string;
  opacity: number;
}

const databaseName = 'fate-appearance-assets';
const storeName = 'background';
const key = 'current';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(new Error('Local background storage is unavailable.'));
    request.onblocked = () => { blocked = true; reject(new Error('Close other Fate UI windows and try again.')); };
  });
}

export async function loadBackground(): Promise<BackgroundImage | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      transaction.oncomplete = () => {
        const value = request.result as Partial<BackgroundImage> | undefined;
        resolve(value?.image instanceof Blob && value.image.type === 'image/png' && value.image.size <= 4 * 1024 * 1024
          && typeof value.name === 'string' && value.name.length <= 160
          && typeof value.opacity === 'number' && Number.isFinite(value.opacity) && value.opacity >= 0.03 && value.opacity <= 0.22
          ? value as BackgroundImage : null);
      };
      transaction.onerror = () => reject(new Error('The saved background could not be read.'));
      transaction.onabort = () => reject(new Error('Reading the background was interrupted.'));
    });
  } finally { database.close(); }
}

export async function saveBackground(value: BackgroundImage | null): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      if (value) store.put(value, key);
      else store.delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('The background could not be saved. Local storage may be full.'));
      transaction.onabort = () => reject(new Error('Saving the background was interrupted.'));
    });
  } finally { database.close(); }
}
