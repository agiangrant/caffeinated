export interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash?: string; // SHA-256 hash of content for cache invalidation
  language: string;
  functionName?: string;
  className?: string;
  enrichedContext?: string; // LLM-generated context for embedding
  summary?: string;
  purpose?: string;
  relatedConcepts?: string[];
  usagePatterns?: string[];
  dependencies?: string[];
}

export interface EmbeddedChunk extends CodeChunk {
  embedding: number[];
}

export interface SearchResult {
  chunk: CodeChunk;
  similarity: number;
}

export interface EmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
  getDimensions(): number;
}

export interface IndexStats {
  totalChunks: number;
  totalFiles: number;
  lastIndexed: Date | null;
  databaseSize: number;
}

export interface CaffeinatedConfig {
  embeddingProvider: 'ollama' | 'custom';
  ollamaEndpoint: string;
  ollamaModel: string;
  customEndpoint: string;
  customApiKey: string;
  indexOnSave: boolean;
  maxFileSize: number;
  excludePatterns: string[];
  chunkSize: number;
  chunkOverlap: number;
}
