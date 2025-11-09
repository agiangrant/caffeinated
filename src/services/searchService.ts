import { VectorDatabase } from '../database/vectorDatabase';
import { EmbeddingService } from './embeddingService';
import { SearchResult } from '../types';
import * as vscode from 'vscode';
import { fuzzySearch } from '../utils/fuzzyMatcher';

export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

export class SearchService {
  private database: VectorDatabase;
  private embeddingService: EmbeddingService;

  constructor(database: VectorDatabase, embeddingService: EmbeddingService) {
    this.database = database;
    this.embeddingService = embeddingService;
  }

  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!query || query.trim().length === 0) {
      throw new Error('Query cannot be empty');
    }

    const config = vscode.workspace.getConfiguration('caffeinated');
    const searchMode = config.get<SearchMode>('searchMode', 'hybrid');

    switch (searchMode) {
      case 'semantic':
        return this.semanticSearch(query, limit);
      case 'keyword':
        return this.keywordOnlySearch(query, limit);
      case 'hybrid':
      default:
        return this.hybridSearch(query, limit);
    }
  }

  private async semanticSearch(query: string, limit: number): Promise<SearchResult[]> {
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    const results = await this.database.search(queryEmbedding, limit);

    return results;
  }

  private async keywordOnlySearch(query: string, limit: number): Promise<SearchResult[]> {
    const keywordResults = await this.database.keywordSearch(query, limit);

    if (keywordResults.length === 0) {
      return [];
    }

    // FTS5 rank is negative (better = closer to 0)
    // Normalize to 0-1 range where 1 is best match
    const bestRank = keywordResults[0].rank; // Most negative (best)
    const worstRank = keywordResults[keywordResults.length - 1].rank; // Least negative (worst)
    const rankRange = Math.abs(worstRank - bestRank) || 1; // Avoid division by zero

    const results: SearchResult[] = [];
    for (const kw of keywordResults) {
      const chunk = await this.getChunkById(kw.chunk_id);
      if (chunk) {
        // Normalize: best match = 1.0, worst match = 0.0
        const normalizedScore = 1.0 - Math.abs(kw.rank - bestRank) / rankRange;
        results.push({
          chunk,
          similarity: normalizedScore,
        });
      }
    }

    return results;
  }

  private async hybridSearch(query: string, limit: number): Promise<SearchResult[]> {
    const config = vscode.workspace.getConfiguration('caffeinated');
    const k = config.get<number>('rrf.k', 60); // RRF constant, typically 60, 50 might be ideal too

    const [semanticResults, keywordResults, allChunks] = await Promise.all([
      this.semanticSearch(query, limit * 2), // Get more results for better ranking
      this.database.keywordSearch(query, limit * 2),
      this.database.getAllChunksForFuzzySearch(),
    ]);

    const fuzzyResults = fuzzySearch(query, allChunks, (chunk) => chunk.file_path, limit * 2);

    const semanticRankMap = new Map<string, number>();
    semanticResults.forEach((result, index) => {
      semanticRankMap.set(result.chunk.id, index + 1);
    });

    const keywordRankMap = new Map<string, number>();
    keywordResults.forEach((result, index) => {
      keywordRankMap.set(result.chunk_id, index + 1);
    });

    const fuzzyRankMap = new Map<string, number>();
    fuzzyResults.forEach((result, index) => {
      fuzzyRankMap.set(result.item.id, index + 1);
    });

    const allChunkIds = new Set([
      ...semanticResults.map((r) => r.chunk.id),
      ...keywordResults.map((r) => r.chunk_id),
      ...fuzzyResults.map((r) => r.item.id),
    ]);

    const rrfScores: Array<{ chunk_id: string; score: number }> = [];
    for (const chunkId of allChunkIds) {
      const semanticRank = semanticRankMap.get(chunkId) || 0;
      const keywordRank = keywordRankMap.get(chunkId) || 0;
      const fuzzyRank = fuzzyRankMap.get(chunkId) || 0;

      // RRF formula: sum(1 / (k + rank_i))
      let rrfScore = 0;
      if (semanticRank > 0) {
        rrfScore += 1 / (k + semanticRank);
      }
      if (keywordRank > 0) {
        rrfScore += 1 / (k + keywordRank);
      }
      if (fuzzyRank > 0) {
        rrfScore += 1 / (k + fuzzyRank);
      }

      rrfScores.push({ chunk_id: chunkId, score: rrfScore });
    }

    rrfScores.sort((a, b) => b.score - a.score);

    const topScores = rrfScores.slice(0, limit);
    if (topScores.length === 0) {
      return [];
    }

    const maxScore = topScores[0].score;
    const minScore = topScores[topScores.length - 1].score;
    const scoreRange = maxScore - minScore || 1; // Avoid division by zero

    const results: SearchResult[] = [];
    for (const { chunk_id, score } of topScores) {
      const chunk = await this.getChunkById(chunk_id);
      if (chunk) {
        // Normalize: best match = 1.0, worst in top results = 0.0
        const normalizedScore = scoreRange > 0 ? (score - minScore) / scoreRange : 1.0; // If all scores equal, give them max score

        results.push({
          chunk,
          similarity: normalizedScore,
        });
      }
    }

    return results;
  }

  private async getChunkById(chunkId: string): Promise<SearchResult['chunk'] | null> {
    return this.database.getChunkById(chunkId);
  }

  async searchWithFilters(
    query: string,
    options: {
      limit?: number;
      minSimilarity?: number;
      filePattern?: string;
      language?: string;
    } = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, minSimilarity = 0.0, filePattern, language } = options;

    const results = await this.search(query, limit * 2); // Get more results for filtering

    let filteredResults = results;

    if (minSimilarity > 0) {
      filteredResults = filteredResults.filter((r) => r.similarity >= minSimilarity);
    }

    if (filePattern) {
      filteredResults = filteredResults.filter((r) => r.chunk.filePath.includes(filePattern));
    }

    if (language) {
      filteredResults = filteredResults.filter((r) => r.chunk.language === language);
    }

    return filteredResults.slice(0, limit);
  }

  async findSimilarFiles(filePath: string, limit: number = 15): Promise<SearchResult[]> {
    const fileChunks = await this.database.getChunksByFile(filePath);

    if (fileChunks.size === 0) {
      return [];
    }

    // In the future we could combine multiple chunks or use a file-level embedding
    const firstChunkId = Array.from(fileChunks.keys())[0];
    const chunk = await this.database.getChunkById(firstChunkId);

    if (!chunk) {
      return [];
    }

    const fileEmbedding = await this.embeddingService.generateEmbedding(chunk.content);

    const results = await this.database.search(fileEmbedding, limit * 2);

    const uniqueFiles = new Map<string, SearchResult>();
    for (const result of results) {
      if (result.chunk.filePath !== filePath && !uniqueFiles.has(result.chunk.filePath)) {
        uniqueFiles.set(result.chunk.filePath, result);
      }

      if (uniqueFiles.size >= limit) {
        break;
      }
    }

    return Array.from(uniqueFiles.values());
  }

  async findSimilarCode(
    filePath: string,
    lineNumber: number,
    limit: number = 15
  ): Promise<SearchResult[]> {
    const chunk = await this.database.getChunkAtLine(filePath, lineNumber);

    if (!chunk) {
      return this.findSimilarFiles(filePath, limit);
    }

    const chunkEmbedding = await this.embeddingService.generateEmbedding(chunk.content);

    const results = await this.database.search(chunkEmbedding, limit * 2);

    const uniqueFiles = new Map<string, SearchResult>();
    for (const result of results) {
      if (result.chunk.id === chunk.id) {
        continue;
      }

      if (!uniqueFiles.has(result.chunk.filePath)) {
        uniqueFiles.set(result.chunk.filePath, result);
      }

      if (uniqueFiles.size >= limit) {
        break;
      }
    }

    return Array.from(uniqueFiles.values());
  }
}
