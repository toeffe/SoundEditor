import type { ProjectState } from '../types';
import { audioBufferToWav } from '../export/FFmpegExporter';
import type { AssetLibrary } from '../audio/AssetLibrary';
import { decodeAudioFile } from '../audio/Decoder';

const DB_NAME = 'soundeditor';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_ASSETS = 'assets';

export interface StoredUiFlags {
  snapEnabled: boolean;
  magneticEnabled: boolean;
  gridStep: number;
  loopEnabled: boolean;
}

export interface StoredProject {
  state: ProjectState;
  ui: StoredUiFlags;
  savedAt: number;
}

interface StoredAsset {
  id: string;
  name: string;
  sampleRate: number;
  numberOfChannels: number;
  wav: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function hasSavedProject(): Promise<boolean> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, 'readonly');
    const val = await idbReq(tx.objectStore(STORE_META).get('project'));
    return !!val;
  } finally {
    db.close();
  }
}

export async function saveProject(
  state: ProjectState,
  library: AssetLibrary,
  ui: StoredUiFlags
): Promise<void> {
  const used = new Set(state.clips.map((c) => c.assetId));
  const assets: StoredAsset[] = [];
  for (const asset of library.all()) {
    if (!used.has(asset.id)) continue;
    const wav = audioBufferToWav(asset.buffer);
    assets.push({
      id: asset.id,
      name: asset.name,
      sampleRate: asset.buffer.sampleRate,
      numberOfChannels: asset.buffer.numberOfChannels,
      wav: new Blob([wav], { type: 'audio/wav' }),
    });
  }

  const payload: StoredProject = {
    state: JSON.parse(JSON.stringify(state)) as ProjectState,
    ui,
    savedAt: Date.now(),
  };

  const db = await openDb();
  try {
    const tx = db.transaction([STORE_META, STORE_ASSETS], 'readwrite');
    const meta = tx.objectStore(STORE_META);
    const assetStore = tx.objectStore(STORE_ASSETS);
    await idbReq(meta.put(payload, 'project'));
    // Clear old assets
    await idbReq(assetStore.clear());
    for (const a of assets) {
      await idbReq(assetStore.put(a));
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Save transaction failed'));
    });
  } finally {
    db.close();
  }
}

export async function loadProject(
  library: AssetLibrary
): Promise<{ state: ProjectState; ui: StoredUiFlags } | null> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_META, STORE_ASSETS], 'readonly');
    const raw = (await idbReq(tx.objectStore(STORE_META).get('project'))) as
      | StoredProject
      | undefined;
    if (!raw?.state) return null;

    const assetStore = tx.objectStore(STORE_ASSETS);
    const allAssets = (await idbReq(assetStore.getAll())) as StoredAsset[];

    library.clear();
    for (const a of allAssets) {
      const file = new File([a.wav], a.name || 'audio.wav', { type: 'audio/wav' });
      const buffer = await decodeAudioFile(file);
      library.restore(a.id, a.name, buffer);
    }

    return {
      state: raw.state,
      ui: raw.ui ?? {
        snapEnabled: false,
        magneticEnabled: true,
        gridStep: 0.1,
        loopEnabled: false,
      },
    };
  } finally {
    db.close();
  }
}

/** Wipe the autosaved browser session (project + assets). */
export async function clearSavedProject(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_META, STORE_ASSETS], 'readwrite');
    await idbReq(tx.objectStore(STORE_META).delete('project'));
    await idbReq(tx.objectStore(STORE_ASSETS).clear());
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Clear transaction failed'));
    });
  } finally {
    db.close();
  }
}
