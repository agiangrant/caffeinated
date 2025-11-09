import * as vscode from 'vscode';
import * as path from 'path';
import { VectorDatabase } from '../database/vectorDatabase';
import { EmbeddingService } from './embeddingService';
import { ContextGenerationService } from './contextGenerationService';
import { CodeChunker } from '../utils/codeChunker';
import { EmbeddedChunk, CodeChunk } from '../types';
import { minimatch } from 'minimatch';
import { Logger } from '../utils/logger';

export class IndexingService {
  private database: VectorDatabase;
  private embeddingService: EmbeddingService;
  private contextGenerationService: ContextGenerationService;
  private codeChunker: CodeChunker;
  private isIndexing: boolean = false;
  private shouldCancelIndexing: boolean = false;
  private indexingProgress: vscode.Progress<{ message?: string; increment?: number }> | null = null;

  constructor(
    database: VectorDatabase,
    embeddingService: EmbeddingService,
    contextGenerationService: ContextGenerationService,
    codeChunker: CodeChunker
  ) {
    this.database = database;
    this.embeddingService = embeddingService;
    this.contextGenerationService = contextGenerationService;
    this.codeChunker = codeChunker;
  }

  async indexWorkspace(
    progressCallback?: (message: string, increment: number) => void
  ): Promise<void> {
    if (this.isIndexing) {
      vscode.window.showWarningMessage('Indexing already in progress');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    this.isIndexing = true;
    this.shouldCancelIndexing = false;

    try {
      const config = vscode.workspace.getConfiguration('caffeinated');
      const excludePatterns = config.get<string[]>('excludePatterns', []);
      const maxFileSize = config.get<number>('maxFileSize', 1048576);

      const files = await vscode.workspace.findFiles(
        '**/*.{ts,tsx,js,jsx,py,java,go,cpp,c,h,hpp,cs,rb,php,swift,kt,rs,html,htm,css,scss,sass,vue}',
        `{${excludePatterns.join(',')}}`
      );

      const totalFiles = files.length;
      let processedFiles = 0;

      Logger.info(`Starting workspace indexing: ${totalFiles} files found`);

      for (const file of files) {
        if (this.shouldCancelIndexing) {
          Logger.info(`Indexing cancelled by user after ${processedFiles} files`);
          vscode.window.showWarningMessage(
            `Caffeinated: Indexing cancelled. Indexed ${processedFiles}/${totalFiles} files.`
          );
          return;
        }

        try {
          const stat = await vscode.workspace.fs.stat(file);
          if (stat.size > maxFileSize) {
            Logger.debug(`Skipping ${file.fsPath}: file too large (${stat.size} bytes)`);
            continue;
          }

          Logger.debug(`Indexing file: ${file.fsPath}`);
          await this.indexFile(file);
          processedFiles++;

          if (progressCallback) {
            const percent = (processedFiles / totalFiles) * 100;
            progressCallback(
              `Indexing: ${processedFiles}/${totalFiles} files`,
              percent / totalFiles
            );
          }
        } catch (error) {
          Logger.error(`Error indexing file ${file.fsPath}`, error);
        }
      }

      Logger.info(`Workspace indexing complete: ${processedFiles} files indexed`);

      vscode.window.showInformationMessage(
        `Caffeinated: Indexed ${processedFiles} files successfully`
      );
    } finally {
      this.isIndexing = false;
      this.shouldCancelIndexing = false;
    }
  }

  async indexFile(fileUri: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration('caffeinated');
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    const batchSize = config.get<number>('contextGenerationBatchSize', 5);

    const relativePath = vscode.workspace.asRelativePath(fileUri);
    for (const pattern of excludePatterns) {
      if (minimatch(relativePath, pattern)) {
        return;
      }
    }

    const document = await vscode.workspace.openTextDocument(fileUri);
    const content = document.getText();
    const language = document.languageId;
    const chunks = this.codeChunker.chunkFile(fileUri.fsPath, content, language);

    Logger.debug(`Chunked ${fileUri.fsPath} into ${chunks.length} chunks`);

    if (chunks.length === 0) {
      return;
    }

    const existingChunks = await this.database.getChunksByFile(fileUri.fsPath);
    const chunksToProcess: CodeChunk[] = [];
    const unchangedChunks: Set<string> = new Set();

    for (const chunk of chunks) {
      const existingHash = existingChunks.get(chunk.id);
      if (existingHash === chunk.contentHash) {
        unchangedChunks.add(chunk.id);
        Logger.debug(
          `  Chunk ${chunk.id} unchanged (hash: ${chunk.contentHash?.substring(0, 8)}...)`
        );
      } else {
        chunksToProcess.push(chunk);
        Logger.debug(
          `  Chunk ${chunk.id} changed or new (hash: ${chunk.contentHash?.substring(0, 8)}...)`
        );
      }
    }

    const currentChunkIds = new Set(chunks.map((c) => c.id));
    for (const [existingId] of existingChunks) {
      if (!currentChunkIds.has(existingId)) {
        Logger.debug(`  Chunk ${existingId} removed from file`);
      }
    }

    // Delete all existing chunks for this file (we'll re-insert the unchanged ones)
    await this.database.deleteChunksByFile(fileUri.fsPath);

    Logger.info(
      `File ${fileUri.fsPath}: ${chunksToProcess.length} chunks to reprocess, ${unchangedChunks.size} unchanged`
    );

    if (chunksToProcess.length === 0 && unchangedChunks.size === 0) {
      return;
    }

    // Enrich chunks with context if enabled (only for changed chunks)
    if (this.contextGenerationService.isEnabled() && chunksToProcess.length > 0) {
      Logger.info(`Generating enriched context for ${chunksToProcess.length} changed chunks`);
      Logger.debug(`Using context generation batch size: ${batchSize}`);

      for (let i = 0; i < chunksToProcess.length; i += batchSize) {
        const batch = chunksToProcess.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(chunksToProcess.length / batchSize);

        Logger.debug(
          `Processing context generation batch ${batchNum}/${totalBatches} (${batch.length} chunks)`
        );
        const batchStartTime = Date.now();

        await Promise.all(
          batch.map(async (chunk) => {
            try {
              const enrichedContext = await this.contextGenerationService.generateContext(chunk);
              if (enrichedContext) {
                chunk.enrichedContext = enrichedContext.fullContext;
                chunk.summary = enrichedContext.summary;
                chunk.purpose = enrichedContext.purpose;
                chunk.relatedConcepts = enrichedContext.relatedConcepts;
                chunk.usagePatterns = enrichedContext.usagePatterns;
                chunk.dependencies = enrichedContext.dependencies;
              }
            } catch (error) {
              console.error(`Error generating context for chunk ${chunk.id}:`, error);
            }
          })
        );

        const batchDuration = Date.now() - batchStartTime;
        Logger.debug(
          `Batch ${batchNum}/${totalBatches} completed in ${batchDuration}ms (avg ${Math.round(
            batchDuration / batch.length
          )}ms per chunk)`
        );
      }
    }

    // Generate embeddings only for changed chunks
    const embeddedChunks: EmbeddedChunk[] = [];

    if (chunksToProcess.length > 0) {
      Logger.debug(`Generating embeddings for ${chunksToProcess.length} changed chunks`);

      const config = vscode.workspace.getConfiguration('caffeinated');
      const embeddingBatchSize = config.get<number>('embeddingBatchSize', 10);
      Logger.debug(`Using embedding batch size: ${embeddingBatchSize}`);

      for (let i = 0; i < chunksToProcess.length; i += embeddingBatchSize) {
        const batch = chunksToProcess.slice(i, i + embeddingBatchSize);

        const batchResults = await Promise.all(
          batch.map(async (chunk) => {
            try {
              const textToEmbed = chunk.enrichedContext || chunk.content;
              const textPreview = textToEmbed.substring(0, 100).replace(/\n/g, ' ');
              Logger.debug(`  Embedding chunk: ${textPreview}... (${textToEmbed.length} chars)`);

              const embedding = await this.embeddingService.generateEmbedding(textToEmbed);
              Logger.debug(`    Generated embedding with ${embedding.length} dimensions`);

              return {
                ...chunk,
                embedding,
              };
            } catch (error) {
              console.error(`Error generating embedding for chunk ${chunk.id}:`, error);
              return null;
            }
          })
        );

        embeddedChunks.push(
          ...batchResults.filter((result): result is EmbeddedChunk => result != null)
        );
      }
    }

    if (embeddedChunks.length > 0) {
      await this.database.insertChunks(embeddedChunks);
    }
  }

  async removeFile(fileUri: vscode.Uri): Promise<void> {
    await this.database.deleteChunksByFile(fileUri.fsPath);
  }

  isCurrentlyIndexing(): boolean {
    return this.isIndexing;
  }

  cancelIndexing(): void {
    if (this.isIndexing) {
      this.shouldCancelIndexing = true;
      Logger.info('Cancellation requested by user');
    }
  }
}
