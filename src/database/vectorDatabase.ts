import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CodeChunk, EmbeddedChunk, SearchResult, IndexStats } from '../types';

export class VectorDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;
  private dimensions: number = 768;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'caffeinated.db');
    this.initialize();
  }

  private initialize(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        function_name TEXT,
        class_name TEXT,
        enriched_context TEXT,
        summary TEXT,
        purpose TEXT,
        related_concepts TEXT,
        usage_patterns TEXT,
        dependencies TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_path ON code_chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_function_name ON code_chunks(function_name);
      CREATE INDEX IF NOT EXISTS idx_class_name ON code_chunks(class_name);
      CREATE INDEX IF NOT EXISTS idx_content_hash ON code_chunks(content_hash);
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        file_path,
        function_name,
        class_name,
        content,
        tokenize = 'porter ascii'
      );
    `);

    this.migrateSchema();
  }

  private migrateSchema(): void {
    if (!this.db) {
      return;
    }

    const tableInfo = this.db.prepare('PRAGMA table_info(code_chunks)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: any;
      pk: number;
    }>;

    const hasContentHash = tableInfo.some((col) => col.name === 'content_hash');

    if (!hasContentHash) {
      this.db.exec(`
        ALTER TABLE code_chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        UPDATE code_chunks SET content_hash = id WHERE content_hash = '';
        CREATE INDEX IF NOT EXISTS idx_content_hash ON code_chunks(content_hash);
      `);
    }

    const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM code_chunks_fts').get() as {
      count: number;
    };
    const chunksCount = this.db.prepare('SELECT COUNT(*) as count FROM code_chunks').get() as {
      count: number;
    };

    if (ftsCount.count === 0 && chunksCount.count > 0) {
      this.db.exec(`
        INSERT INTO code_chunks_fts (chunk_id, file_path, function_name, class_name, content)
        SELECT id, file_path, COALESCE(function_name, ''), COALESCE(class_name, ''), content
        FROM code_chunks;
      `);
    }
  }

  setDimensions(dimensions: number): void {
    this.dimensions = dimensions;
  }

  async insertChunk(chunk: EmbeddedChunk): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const now = Date.now();

    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks
      (id, file_path, start_line, end_line, content, content_hash, language, function_name, class_name,
       enriched_context, summary, purpose, related_concepts, usage_patterns, dependencies,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertChunk.run(
      chunk.id,
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.contentHash || chunk.id,
      chunk.language,
      chunk.functionName || null,
      chunk.className || null,
      chunk.enrichedContext || null,
      chunk.summary || null,
      chunk.purpose || null,
      chunk.relatedConcepts ? JSON.stringify(chunk.relatedConcepts) : null,
      chunk.usagePatterns ? JSON.stringify(chunk.usagePatterns) : null,
      chunk.dependencies ? JSON.stringify(chunk.dependencies) : null,
      now,
      now
    );

    const embeddingBlob = Buffer.from(new Float32Array(chunk.embedding).buffer);
    const insertEmbedding = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `);

    insertEmbedding.run(chunk.id, embeddingBlob);

    const insertFts = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks_fts (chunk_id, file_path, function_name, class_name, content)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertFts.run(
      chunk.id,
      chunk.filePath,
      chunk.functionName || '',
      chunk.className || '',
      chunk.content
    );
  }

  async insertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const insertChunk = this.db.transaction((chunks: EmbeddedChunk[]) => {
      for (const chunk of chunks) {
        const now = Date.now();

        this.db!.prepare(
          `
          INSERT OR REPLACE INTO code_chunks
          (id, file_path, start_line, end_line, content, content_hash, language, function_name, class_name,
           enriched_context, summary, purpose, related_concepts, usage_patterns, dependencies,
           created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          chunk.id,
          chunk.filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.contentHash || chunk.id,
          chunk.language,
          chunk.functionName || null,
          chunk.className || null,
          chunk.enrichedContext || null,
          chunk.summary || null,
          chunk.purpose || null,
          chunk.relatedConcepts ? JSON.stringify(chunk.relatedConcepts) : null,
          chunk.usagePatterns ? JSON.stringify(chunk.usagePatterns) : null,
          chunk.dependencies ? JSON.stringify(chunk.dependencies) : null,
          now,
          now
        );

        const embeddingBlob = Buffer.from(new Float32Array(chunk.embedding).buffer);
        this.db!.prepare(
          `
          INSERT OR REPLACE INTO embeddings (chunk_id, embedding)
          VALUES (?, ?)
        `
        ).run(chunk.id, embeddingBlob);

        this.db!.prepare(
          `
          INSERT OR REPLACE INTO code_chunks_fts (chunk_id, file_path, function_name, class_name, content)
          VALUES (?, ?, ?, ?, ?)
        `
        ).run(
          chunk.id,
          chunk.filePath,
          chunk.functionName || '',
          chunk.className || '',
          chunk.content
        );
      }
    });

    insertChunk(chunks);
  }

  async search(queryEmbedding: number[], limit: number = 10): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const rows = this.db
      .prepare(
        `
      SELECT c.*, e.embedding
      FROM code_chunks c
      JOIN embeddings e ON c.id = e.chunk_id
    `
      )
      .all() as Array<{
      id: string;
      file_path: string;
      start_line: number;
      end_line: number;
      content: string;
      language: string;
      function_name: string | null;
      class_name: string | null;
      embedding: Buffer;
    }>;

    const results: SearchResult[] = rows
      .map((row) => {
        const embedding = new Float32Array(row.embedding.buffer);
        const similarity = this.cosineSimilarity(queryEmbedding, Array.from(embedding));

        return {
          chunk: {
            id: row.id,
            filePath: row.file_path,
            startLine: row.start_line,
            endLine: row.end_line,
            content: row.content,
            language: row.language,
            functionName: row.function_name || undefined,
            className: row.class_name || undefined,
          },
          similarity,
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return results;
  }

  async keywordSearch(
    query: string,
    limit: number = 20
  ): Promise<Array<{ chunk_id: string; rank: number }>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (!query || !query.trim()) {
      return [];
    }

    try {
      // Remove FTS5 special characters for natural search
      // FTS5 special chars: " * : ( ) AND OR NOT NEAR
      // Replace with spaces to preserve word boundaries
      const cleanedQuery = query
        .replace(/[:"*()\[\]]/g, ' ') // Replace special chars with spaces
        .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ') // Remove FTS5 operators
        .replace(/\s+/g, ' ') // Normalize multiple spaces
        .trim();

      if (!cleanedQuery) {
        return [];
      }

      // Use FTS5 match with BM25 ranking
      const rows = this.db
        .prepare(
          `
        SELECT
          chunk_id,
          rank as rank
        FROM code_chunks_fts
        WHERE code_chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
        )
        .all(cleanedQuery, limit) as Array<{ chunk_id: string; rank: number }>;

      return rows;
    } catch (error) {
      console.error('FTS5 search error:', error);
      return [];
    }
  }

  async getAllChunksForFuzzySearch(): Promise<Array<{ id: string; file_path: string }>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const rows = this.db.prepare('SELECT id, file_path FROM code_chunks').all() as Array<{
      id: string;
      file_path: string;
    }>;

    return rows;
  }

  async getChunkById(chunkId: string): Promise<{
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    functionName?: string;
    className?: string;
  } | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const row = this.db
      .prepare(
        `
      SELECT
        id,
        file_path,
        start_line,
        end_line,
        content,
        language,
        function_name,
        class_name
      FROM code_chunks
      WHERE id = ?
    `
      )
      .get(chunkId) as
      | {
          id: string;
          file_path: string;
          start_line: number;
          end_line: number;
          content: string;
          language: string;
          function_name: string | null;
          class_name: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      language: row.language,
      functionName: row.function_name || undefined,
      className: row.class_name || undefined,
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async deleteChunksByFile(filePath: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const chunkIds = this.db
      .prepare('SELECT id FROM code_chunks WHERE file_path = ?')
      .all(filePath) as Array<{ id: string }>;

    const deleteFts = this.db.prepare('DELETE FROM code_chunks_fts WHERE chunk_id = ?');
    for (const { id } of chunkIds) {
      deleteFts.run(id);
    }

    this.db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(filePath);
  }

  async getChunksByFile(filePath: string): Promise<Map<string, string>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const rows = this.db
      .prepare('SELECT id, content_hash FROM code_chunks WHERE file_path = ?')
      .all(filePath) as Array<{ id: string; content_hash: string }>;

    const hashMap = new Map<string, string>();
    rows.forEach((row) => {
      hashMap.set(row.id, row.content_hash);
    });

    return hashMap;
  }

  async getChunkAtLine(
    filePath: string,
    lineNumber: number
  ): Promise<{
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    functionName?: string;
    className?: string;
  } | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const row = this.db
      .prepare(
        `
      SELECT
        id,
        file_path,
        start_line,
        end_line,
        content,
        language,
        function_name,
        class_name
      FROM code_chunks
      WHERE file_path = ? AND ? >= start_line AND ? <= end_line
      ORDER BY (end_line - start_line) ASC
      LIMIT 1
    `
      )
      .get(filePath, lineNumber, lineNumber) as
      | {
          id: string;
          file_path: string;
          start_line: number;
          end_line: number;
          content: string;
          language: string;
          function_name: string | null;
          class_name: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      language: row.language,
      functionName: row.function_name || undefined,
      className: row.class_name || undefined,
    };
  }

  async chunkExistsWithHash(id: string, contentHash: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db
      .prepare('SELECT 1 FROM code_chunks WHERE id = ? AND content_hash = ? LIMIT 1')
      .get(id, contentHash);

    return result !== undefined;
  }

  async getStats(): Promise<IndexStats> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const totalChunks = this.db.prepare('SELECT COUNT(*) as count FROM code_chunks').get() as {
      count: number;
    };

    const totalFiles = this.db
      .prepare('SELECT COUNT(DISTINCT file_path) as count FROM code_chunks')
      .get() as { count: number };

    const lastIndexed = this.db
      .prepare('SELECT MAX(updated_at) as last FROM code_chunks')
      .get() as { last: number | null };

    const databaseSize = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;

    return {
      totalChunks: totalChunks.count,
      totalFiles: totalFiles.count,
      lastIndexed: lastIndexed.last ? new Date(lastIndexed.last) : null,
      databaseSize,
    };
  }

  async clearAll(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.exec(`
      DELETE FROM embeddings;
      DELETE FROM code_chunks;
      DELETE FROM code_chunks_fts;
    `);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
