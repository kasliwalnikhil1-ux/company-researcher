// CSV processing progress persistence utilities

import { CsvRow } from './csvImport';

export interface CsvProgressState {
  headers: string[];
  rows: CsvRow[];
  selectedUrlColumn: string;
  processedDomainIndices: number[]; // Indices of domains that have been processed
  uniqueDomains: string[];
  qualificationDataMap: { [domain: string]: any }; // Serialized qualification data
  errorMap: { [domain: string]: string };
  lastSavedAt: number; // Timestamp
  totalDomains: number;
  currentDomainIndex: number;
}

const PROGRESS_STORAGE_KEY = 'csv-processing-progress';
const AUTO_SAVE_INTERVAL = 5000; // Save every 5 seconds
const AUTO_SAVE_BATCH_SIZE = 10; // Save after every 10 domains processed

// Save progress to localStorage
export const saveCsvProgress = (state: CsvProgressState): void => {
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(PROGRESS_STORAGE_KEY, serialized);
  } catch (error) {
    console.error('Failed to save CSV progress:', error);
    // If localStorage is full, try to clear old data
    try {
      localStorage.removeItem(PROGRESS_STORAGE_KEY);
      localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save CSV progress after clearing:', e);
    }
  }
};

// Load progress from localStorage
export const loadCsvProgress = (): CsvProgressState | null => {
  try {
    const stored = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!stored) return null;
    
    const state = JSON.parse(stored) as CsvProgressState;
    
    // Validate that the state is not too old (e.g., older than 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (state.lastSavedAt < sevenDaysAgo) {
      clearCsvProgress();
      return null;
    }
    
    return state;
  } catch (error) {
    console.error('Failed to load CSV progress:', error);
    return null;
  }
};

// Clear saved progress
export const clearCsvProgress = (): void => {
  try {
    localStorage.removeItem(PROGRESS_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear CSV progress:', error);
  }
};

// Check if there's saved progress
export const hasCsvProgress = (): boolean => {
  return loadCsvProgress() !== null;
};

// Convert Map to plain object for serialization
export const serializeQualificationDataMap = (map: Map<string, any>): { [key: string]: any } => {
  const obj: { [key: string]: any } = {};
  map.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
};

// Convert plain object back to Map
export const deserializeQualificationDataMap = (obj: { [key: string]: any }): Map<string, any> => {
  const map = new Map<string, any>();
  Object.entries(obj).forEach(([key, value]) => {
    map.set(key, value);
  });
  return map;
};

// Helper to determine if we should auto-save based on time or batch size
export const shouldAutoSave = (
  lastSavedAt: number | null,
  processedCount: number,
  batchSize: number = AUTO_SAVE_BATCH_SIZE
): boolean => {
  if (!lastSavedAt) return true;
  
  const timeSinceLastSave = Date.now() - lastSavedAt;
  const shouldSaveByTime = timeSinceLastSave >= AUTO_SAVE_INTERVAL;
  const shouldSaveByBatch = processedCount % batchSize === 0;
  
  return shouldSaveByTime || shouldSaveByBatch;
};

