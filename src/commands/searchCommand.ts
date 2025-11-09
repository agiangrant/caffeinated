import * as vscode from 'vscode';
import { SearchService } from '../services/searchService';
import { SearchResult } from '../types';

export class SearchCommand {
  private searchService: SearchService;

  constructor(searchService: SearchService) {
    this.searchService = searchService;
  }

  async execute(): Promise<void> {
    const query = await vscode.window.showInputBox({
      prompt: 'Enter semantic search query',
      placeHolder: 'e.g., function that handles file uploads',
    });

    if (!query) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Caffeinated',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Searching...' });

        try {
          const results = await this.searchService.search(query, 20);

          if (results.length === 0) {
            vscode.window.showInformationMessage('No results found');
            return;
          }

          await this.displayResults(results, query);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    );
  }

  private async displayResults(results: SearchResult[], query: string): Promise<void> {
    interface ResultQuickPickItem extends vscode.QuickPickItem {
      result: SearchResult;
    }

    const items: ResultQuickPickItem[] = results.map((result) => {
      const fileName = result.chunk.filePath.split('/').pop() || result.chunk.filePath;
      const similarity = (result.similarity * 100).toFixed(1);
      const preview = result.chunk.content.substring(0, 100).replace(/\n/g, ' ');

      return {
        label: `$(file-code) ${fileName}`,
        description: `${similarity}% - Lines ${result.chunk.startLine}-${result.chunk.endLine}`,
        detail: preview + (result.chunk.content.length > 100 ? '...' : ''),
        result,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Found ${results.length} results for "${query}"`,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) {
      await this.openResult(selected.result);
    }
  }

  private async openResult(result: SearchResult): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(result.chunk.filePath)
      );
      const editor = await vscode.window.showTextDocument(document);

      const startPos = new vscode.Position(result.chunk.startLine, 0);
      const endPos = new vscode.Position(result.chunk.endLine, 0);
      const range = new vscode.Range(startPos, endPos);

      editor.selection = new vscode.Selection(startPos, startPos);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

      const decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        isWholeLine: true,
      });

      editor.setDecorations(decorationType, [range]);

      setTimeout(() => {
        decorationType.dispose();
      }, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
