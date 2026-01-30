// CSV processing progress persistence utilities

import { CsvRow } from './csvImport';

export interface CsvProgressState {
  headers: string[];
  // rows: CsvRow[]; // Removed - we'll reconstruct from qualificationDataMap to save space
  selectedUrlColumn: string;
  processedDomainIndices: number[]; // Indices of domains that have been processed
  uniqueDomains: string[];
  qualificationDataMap: { [domain: string]: any }; // Serialized qualification data
  errorMap: { [domain: string]: string };
  lastSavedAt: number; // Timestamp
  totalDomains: number;
  currentDomainIndex: number;
  // Additional metadata for reconstruction
  selectedColumns?: { domain: string | null; instagram: string | null };
  researchMode?: 'domain' | 'instagram' | 'investor';
}

const PROGRESS_STORAGE_KEY = 'csv-processing-progress';
const AUTO_SAVE_INTERVAL = 5000; // Save every 5 seconds
const AUTO_SAVE_BATCH_SIZE = 10; // Save after every 10 domains processed

// Save progress to localStorage (optimized - doesn't save full rows array)
export const saveCsvProgress = (state: CsvProgressState): void => {
  try {
    // Create a minimal state without the rows array to save space
    const minimalState = {
      headers: state.headers,
      selectedUrlColumn: state.selectedUrlColumn,
      processedDomainIndices: state.processedDomainIndices,
      uniqueDomains: state.uniqueDomains,
      qualificationDataMap: state.qualificationDataMap,
      errorMap: state.errorMap,
      lastSavedAt: state.lastSavedAt,
      totalDomains: state.totalDomains,
      currentDomainIndex: state.currentDomainIndex,
      selectedColumns: state.selectedColumns,
      researchMode: state.researchMode,
    };
    
    const serialized = JSON.stringify(minimalState);
    
    // Check size before saving (localStorage limit is typically 5-10MB)
    const sizeInMB = new Blob([serialized]).size / (1024 * 1024);
    if (sizeInMB > 4) {
      console.warn(`Progress data is large (${sizeInMB.toFixed(2)}MB). Consider clearing old data.`);
    }
    
    localStorage.setItem(PROGRESS_STORAGE_KEY, serialized);
  } catch (error: any) {
    console.error('Failed to save CSV progress:', error);
    
    // If localStorage is full (quota exceeded), try to clear old data and save again
    if (error.name === 'QuotaExceededError' || error.code === 22) {
      try {
        console.warn('localStorage quota exceeded. Attempting to clear old data...');
        localStorage.removeItem(PROGRESS_STORAGE_KEY);
        
        // Try saving again with minimal data
        const minimalState = {
          headers: state.headers,
          selectedUrlColumn: state.selectedUrlColumn,
          processedDomainIndices: state.processedDomainIndices,
          uniqueDomains: state.uniqueDomains,
          qualificationDataMap: state.qualificationDataMap,
          errorMap: state.errorMap,
          lastSavedAt: state.lastSavedAt,
          totalDomains: state.totalDomains,
          currentDomainIndex: state.currentDomainIndex,
          selectedColumns: state.selectedColumns,
          researchMode: state.researchMode,
        };
        
        localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(minimalState));
        console.log('Successfully saved progress after clearing old data');
      } catch (e) {
        console.error('Failed to save CSV progress after clearing:', e);
        // Last resort: try to save only the most critical data
        try {
          const criticalState = {
            headers: state.headers,
            selectedUrlColumn: state.selectedUrlColumn,
            processedDomainIndices: state.processedDomainIndices,
            uniqueDomains: state.uniqueDomains,
            lastSavedAt: state.lastSavedAt,
            totalDomains: state.totalDomains,
            currentDomainIndex: state.currentDomainIndex,
          };
          localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(criticalState));
          console.warn('Saved minimal progress data (qualification data may be lost)');
        } catch (finalError) {
          console.error('Failed to save even minimal progress:', finalError);
        }
      }
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

