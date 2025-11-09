import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js-fts5';
import * as path from 'path';
import * as fs from 'fs';
import { EmbeddedChunk, SearchResult, IndexStats } from '../types';

export class VectorDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private SQL: SqlJsStatic | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'caffeinated.db');
    this.initPromise = this.initialize();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Try multiple paths to find the WASM file (handles different build/packaging scenarios)
    const possiblePaths = [
      path.join(__dirname, '../../node_modules/sql.js-fts5/dist/sql-wasm.wasm'),
      path.join(__dirname, '../node_modules/sql.js-fts5/dist/sql-wasm.wasm'),
      path.join(__dirname, 'node_modules/sql.js-fts5/dist/sql-wasm.wasm'),
    ];

    let wasmBinary: Buffer | null = null;
    for (const wasmPath of possiblePaths) {
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        break;
      }
    }

    if (!wasmBinary) {
      throw new Error(
        'Could not find sql-wasm.wasm file. Tried paths: ' + possiblePaths.join(', ')
      );
    }

    this.SQL = await initSqlJs({
      wasmBinary: wasmBinary,
    });

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run(`
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

    this.db.run(`
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

    const tableInfo = this.db.exec('PRAGMA table_info(code_chunks)');

    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map((row: any) => row[1] as string);
      const hasContentHash = columns.includes('content_hash');

      if (!hasContentHash) {
        this.db.run(`
          ALTER TABLE code_chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        `);
        this.db.run(`UPDATE code_chunks SET content_hash = id WHERE content_hash = '';`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_content_hash ON code_chunks(content_hash);`);
      }
    }

    const ftsCount = this.db.exec('SELECT COUNT(*) as count FROM code_chunks_fts');
    const chunksCount = this.db.exec('SELECT COUNT(*) as count FROM code_chunks');

    const ftsCountValue = ftsCount.length > 0 ? (ftsCount[0].values[0][0] as number) : 0;
    const chunksCountValue = chunksCount.length > 0 ? (chunksCount[0].values[0][0] as number) : 0;

    if (ftsCountValue === 0 && chunksCountValue > 0) {
      this.db.run(`
        INSERT INTO code_chunks_fts (chunk_id, file_path, function_name, class_name, content)
        SELECT id, file_path, COALESCE(function_name, ''), COALESCE(class_name, ''), content
        FROM code_chunks;
      `);
    }

    this.saveToFile();
  }

  private saveToFile(): void {
    if (!this.db) {
      return;
    }

    const data = this.db.export();
    fs.writeFileSync(this.dbPath, data);
  }

  async insertChunk(chunk: EmbeddedChunk): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const now = Date.now();

    this.db.run(
      `
      INSERT OR REPLACE INTO code_chunks
      (id, file_path, start_line, end_line, content, content_hash, language, function_name, class_name,
       enriched_context, summary, purpose, related_concepts, usage_patterns, dependencies,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
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
        now,
      ]
    );

    const float32Array = new Float32Array(chunk.embedding);
    const embeddingBlob = new Uint8Array(float32Array.buffer);

    this.db.run(
      `
      INSERT OR REPLACE INTO embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `,
      [chunk.id, embeddingBlob]
    );

    this.db.run(
      `
      INSERT OR REPLACE INTO code_chunks_fts (chunk_id, file_path, function_name, class_name, content)
      VALUES (?, ?, ?, ?, ?)
    `,
      [chunk.id, chunk.filePath, chunk.functionName || '', chunk.className || '', chunk.content]
    );

    this.saveToFile();
  }

  async insertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    for (const chunk of chunks) {
      const now = Date.now();

      this.db.run(
        `
        INSERT OR REPLACE INTO code_chunks
        (id, file_path, start_line, end_line, content, content_hash, language, function_name, class_name,
         enriched_context, summary, purpose, related_concepts, usage_patterns, dependencies,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
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
          now,
        ]
      );

      const float32Array = new Float32Array(chunk.embedding);
      const embeddingBlob = new Uint8Array(float32Array.buffer);

      this.db.run(
        `
        INSERT OR REPLACE INTO embeddings (chunk_id, embedding)
        VALUES (?, ?)
      `,
        [chunk.id, embeddingBlob]
      );

      this.db.run(
        `
        INSERT OR REPLACE INTO code_chunks_fts (chunk_id, file_path, function_name, class_name, content)
        VALUES (?, ?, ?, ?, ?)
      `,
        [chunk.id, chunk.filePath, chunk.functionName || '', chunk.className || '', chunk.content]
      );
    }

    this.saveToFile();
  }

  async search(queryEmbedding: number[], limit: number = 10): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(`
      SELECT c.*, e.embedding
      FROM code_chunks c
      JOIN embeddings e ON c.id = e.chunk_id
    `);

    if (result.length === 0 || result[0].values.length === 0) {
      return [];
    }

    const rows = result[0];
    const searchResults: SearchResult[] = [];

    for (let i = 0; i < rows.values.length; i++) {
      const row = rows.values[i];
      const id = row[0] as string;
      const file_path = row[1] as string;
      const start_line = row[2] as number;
      const end_line = row[3] as number;
      const content = row[4] as string;
      const language = row[6] as string;
      const function_name = row[7] as string | null;
      const class_name = row[8] as string | null;
      const embeddingBuffer = row[17];

      let embedding: Float32Array;
      try {
        if (embeddingBuffer instanceof Uint8Array) {
          const arrayBuffer = embeddingBuffer.buffer.slice(
            embeddingBuffer.byteOffset,
            embeddingBuffer.byteOffset + embeddingBuffer.byteLength
          );
          embedding = new Float32Array(arrayBuffer);
        } else if (embeddingBuffer instanceof ArrayBuffer) {
          embedding = new Float32Array(embeddingBuffer);
        } else if (typeof embeddingBuffer === 'number') {
          console.error(
            `[VectorDatabase] Found corrupted embedding data from previous database version.\n` +
              `Please run "Caffeinated: Reindex Workspace (Clear & Rebuild)" to fix this issue.`
          );
          continue;
        } else {
          console.error(
            `[VectorDatabase] Unexpected embedding buffer type for chunk ${id}:`,
            typeof embeddingBuffer,
            embeddingBuffer
          );
          continue;
        }
      } catch (error) {
        console.error(`[VectorDatabase] Error converting embedding buffer for chunk ${id}:`, error);
        continue;
      }

      if (embedding.length !== queryEmbedding.length) {
        console.error(
          `[VectorDatabase] Dimension mismatch in chunk ${id}: ` +
            `query=${queryEmbedding.length}, stored=${embedding.length}. ` +
            `This chunk will be skipped. You may need to re-index your workspace.`
        );
        continue;
      }

      const similarity = this.cosineSimilarity(queryEmbedding, Array.from(embedding));

      searchResults.push({
        chunk: {
          id,
          filePath: file_path,
          startLine: start_line,
          endLine: end_line,
          content,
          language,
          functionName: function_name || undefined,
          className: class_name || undefined,
        },
        similarity,
      });
    }

    return searchResults.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async keywordSearch(
    query: string,
    limit: number = 20
  ): Promise<Array<{ chunk_id: string; rank: number }>> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (!query || !query.trim()) {
      return [];
    }

    try {
      const cleanedQuery = query
        .replace(/[:"*()\[\]]/g, ' ')
        .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanedQuery) {
        return [];
      }

      const result = this.db.exec(
        `
        SELECT
          chunk_id,
          rank as rank
        FROM code_chunks_fts
        WHERE code_chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
        [cleanedQuery, limit]
      );

      if (result.length === 0) {
        return [];
      }

      const rows: Array<{ chunk_id: string; rank: number }> = [];
      for (let i = 0; i < result[0].values.length; i++) {
        const row = result[0].values[i];
        rows.push({
          chunk_id: row[0] as string,
          rank: row[1] as number,
        });
      }

      return rows;
    } catch (error) {
      console.error('FTS5 search error:', error);
      return [];
    }
  }

  async getAllChunksForFuzzySearch(): Promise<Array<{ id: string; file_path: string }>> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec('SELECT id, file_path FROM code_chunks');

    if (result.length === 0) {
      return [];
    }

    const rows: Array<{ id: string; file_path: string }> = [];
    for (let i = 0; i < result[0].values.length; i++) {
      const row = result[0].values[i];
      rows.push({
        id: row[0] as string,
        file_path: row[1] as string,
      });
    }

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
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
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
    `,
      [chunkId]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const row = result[0].values[0];
    return {
      id: row[0] as string,
      filePath: row[1] as string,
      startLine: row[2] as number,
      endLine: row[3] as number,
      content: row[4] as string,
      language: row[5] as string,
      functionName: (row[6] as string | null) || undefined,
      className: (row[7] as string | null) || undefined,
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
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec('SELECT id FROM code_chunks WHERE file_path = ?', [filePath]);

    if (result.length > 0) {
      for (let i = 0; i < result[0].values.length; i++) {
        const id = result[0].values[i][0] as string;
        this.db.run('DELETE FROM code_chunks_fts WHERE chunk_id = ?', [id]);
      }
    }

    this.db.run('DELETE FROM code_chunks WHERE file_path = ?', [filePath]);

    this.saveToFile();
  }

  async getChunksByFile(filePath: string): Promise<Map<string, string>> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec('SELECT id, content_hash FROM code_chunks WHERE file_path = ?', [
      filePath,
    ]);

    const hashMap = new Map<string, string>();

    if (result.length > 0) {
      for (let i = 0; i < result[0].values.length; i++) {
        const row = result[0].values[i];
        hashMap.set(row[0] as string, row[1] as string);
      }
    }

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
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
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
    `,
      [filePath, lineNumber, lineNumber]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const row = result[0].values[0];
    return {
      id: row[0] as string,
      filePath: row[1] as string,
      startLine: row[2] as number,
      endLine: row[3] as number,
      content: row[4] as string,
      language: row[5] as string,
      functionName: (row[6] as string | null) || undefined,
      className: (row[7] as string | null) || undefined,
    };
  }

  async chunkExistsWithHash(id: string, contentHash: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
      'SELECT 1 FROM code_chunks WHERE id = ? AND content_hash = ? LIMIT 1',
      [id, contentHash]
    );

    return result.length > 0 && result[0].values.length > 0;
  }

  async getStats(): Promise<IndexStats> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const totalChunksResult = this.db.exec('SELECT COUNT(*) as count FROM code_chunks');
    const totalChunks =
      totalChunksResult.length > 0 ? (totalChunksResult[0].values[0][0] as number) : 0;

    const totalFilesResult = this.db.exec(
      'SELECT COUNT(DISTINCT file_path) as count FROM code_chunks'
    );
    const totalFiles =
      totalFilesResult.length > 0 ? (totalFilesResult[0].values[0][0] as number) : 0;

    const lastIndexedResult = this.db.exec('SELECT MAX(updated_at) as last FROM code_chunks');
    const lastIndexed =
      lastIndexedResult.length > 0 && lastIndexedResult[0].values.length > 0
        ? (lastIndexedResult[0].values[0][0] as number | null)
        : null;

    const databaseSize = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;

    return {
      totalChunks,
      totalFiles,
      lastIndexed: lastIndexed ? new Date(lastIndexed) : null,
      databaseSize,
    };
  }

  async clearAll(): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run(`DELETE FROM embeddings;`);
    this.db.run(`DELETE FROM code_chunks;`);
    this.db.run(`DELETE FROM code_chunks_fts;`);

    this.saveToFile();
  }

  close(): void {
    if (this.db) {
      this.saveToFile();
      this.db.close();
      this.db = null;
    }
  }
}
