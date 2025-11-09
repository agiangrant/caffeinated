import * as vscode from 'vscode';
import { IndexingService } from '../services/indexingService';
import { VectorDatabase } from '../database/vectorDatabase';

export class IndexCommand {
  private indexingService: IndexingService;
  private database: VectorDatabase;

  constructor(indexingService: IndexingService, database: VectorDatabase) {
    this.indexingService = indexingService;
    this.database = database;
  }

  async indexWorkspace(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Caffeinated: Indexing workspace',
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          this.indexingService.cancelIndexing();
        });

        await this.indexingService.indexWorkspace((message, increment) => {
          progress.report({ message, increment });
        });
      }
    );
  }

  async clearIndex(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to clear the entire index?',
      { modal: true },
      'Yes',
      'No'
    );

    if (confirm === 'Yes') {
      await this.database.clearAll();
      vscode.window.showInformationMessage('Caffeinated: Index cleared successfully');
    }
  }

  async reindexWorkspace(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'This will clear the entire index and rebuild it from scratch. Continue?',
      { modal: true },
      'Yes',
      'No'
    );

    if (confirm === 'Yes') {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Caffeinated: Reindexing workspace',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            this.indexingService.cancelIndexing();
          });

          progress.report({ message: 'Clearing old index...' });
          await this.database.clearAll();

          progress.report({ message: 'Building new index...', increment: 10 });
          await this.indexingService.indexWorkspace((message, increment) => {
            progress.report({ message, increment });
          });
        }
      );

      vscode.window.showInformationMessage('Caffeinated: Workspace reindexed successfully');
    }
  }

  async showStatus(): Promise<void> {
    const stats = await this.database.getStats();

    const sizeInMB = (stats.databaseSize / 1024 / 1024).toFixed(2);
    const lastIndexedStr = stats.lastIndexed ? stats.lastIndexed.toLocaleString() : 'Never';

    const message = `
Index Statistics:
- Total Chunks: ${stats.totalChunks}
- Total Files: ${stats.totalFiles}
- Database Size: ${sizeInMB} MB
- Last Indexed: ${lastIndexedStr}
    `.trim();

    vscode.window.showInformationMessage(message, { modal: true });
  }
}
