import * as vscode from 'vscode';
import { SearchService } from '../services/searchService';
import { SearchResult } from '../types';

export class QuickSearchCommand {
  private searchService: SearchService;

  constructor(searchService: SearchService) {
    this.searchService = searchService;
  }

  async execute(): Promise<void> {
    const quickPick = vscode.window.createQuickPick<ResultQuickPickItem>();
    quickPick.placeholder = 'Search code semantically (e.g., "function that handles file uploads")';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let currentQuery = '';
    let debounceTimer: NodeJS.Timeout | undefined;

    quickPick.busy = true;
    try {
      const defaultItems = await this.getDefaultItems();
      quickPick.items = defaultItems;
    } catch (error) {
      console.error('Failed to load default items:', error);
    } finally {
      quickPick.busy = false;
    }

    quickPick.onDidChangeValue(async (value) => {
      if (value === currentQuery) {
        return;
      }

      if (!value.trim()) {
        currentQuery = '';
        quickPick.busy = true;
        try {
          const defaultItems = await this.getDefaultItems();
          quickPick.items = defaultItems;
        } catch (error) {
          console.error('Failed to load default items:', error);
        } finally {
          quickPick.busy = false;
        }
        return;
      }

      currentQuery = value;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      quickPick.busy = true;

      debounceTimer = setTimeout(async () => {
        try {
          const results = await this.searchService.search(value, 20);

          if (currentQuery !== value) {
            return;
          }

          quickPick.items = this.createQuickPickItems(results, value);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        } finally {
          quickPick.busy = false;
        }
      }, 300);
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        return;
      }

      quickPick.hide();

      if ('result' in selected && selected.result) {
        await this.openResult(selected.result);
      } else if ('filePath' in selected && selected.filePath) {
        try {
          const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(selected.filePath)
          );
          await vscode.window.showTextDocument(document);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open file: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    });

    quickPick.onDidHide(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      quickPick.dispose();
    });

    quickPick.show();
  }

  private async getDefaultItems(): Promise<ResultQuickPickItem[]> {
    const items: ResultQuickPickItem[] = [];

    try {
      const openFiles = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => (tab.input as any)?.uri?.fsPath)
        .filter((path): path is string => !!path);

      for (const filePath of openFiles.slice(0, 10)) {
        const fileName = filePath.split('/').pop() || filePath;
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

        items.push({
          label: `$(file) ${fileName}`,
          description: '',
          detail: dirPath,
          filePath,
          alwaysShow: true,
        });
      }
    } catch (error) {
      console.error('Failed to get open files:', error);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      try {
        const activeFilePath = activeEditor.document.uri.fsPath;
        const cursorLine = activeEditor.selection.active.line;

        const similarResults = await this.searchService.findSimilarCode(
          activeFilePath,
          cursorLine,
          15
        );

        if (similarResults.length > 0) {
          if (items.length > 0) {
            items.push({
              label: '',
              kind: vscode.QuickPickItemKind.Separator,
              alwaysShow: true,
            } as ResultQuickPickItem);
          }

          for (const result of similarResults) {
            const fileName = result.chunk.filePath.split('/').pop() || result.chunk.filePath;
            const dirPath = result.chunk.filePath.substring(
              0,
              result.chunk.filePath.lastIndexOf('/')
            );
            const similarity = (result.similarity * 100).toFixed(0);

            let contextInfo = '';
            if (result.chunk.functionName) {
              contextInfo = ` · ${result.chunk.functionName}()`;
            } else if (result.chunk.className) {
              contextInfo = ` · ${result.chunk.className}`;
            }

            items.push({
              label: `$(file-code) ${fileName}${contextInfo}`,
              description: `${similarity}% similar`,
              detail: dirPath,
              result,
              alwaysShow: true,
            });
          }
        }
      } catch (error) {
        console.error('Failed to get similar code:', error);
      }
    }

    if (items.length === 0) {
      items.push({
        label: '$(info) No open files',
        description: 'Open some files or start typing to search',
        alwaysShow: true,
      } as ResultQuickPickItem);
    }

    return items;
  }

  private createQuickPickItems(results: SearchResult[], query: string): ResultQuickPickItem[] {
    if (results.length === 0) {
      return [
        {
          label: '$(info) No results found',
          description: `for "${query}"`,
          alwaysShow: true,
        } as ResultQuickPickItem,
      ];
    }

    return results.map((result) => {
      const fileName = result.chunk.filePath.split('/').pop() || result.chunk.filePath;
      const dirPath = result.chunk.filePath.substring(0, result.chunk.filePath.lastIndexOf('/'));
      const similarity = (result.similarity * 100).toFixed(1);
      const preview = result.chunk.content.substring(0, 150).replace(/\n/g, ' ').trim();

      let contextInfo = '';
      if (result.chunk.functionName) {
        contextInfo = `$(symbol-method) ${result.chunk.functionName}`;
      } else if (result.chunk.className) {
        contextInfo = `$(symbol-class) ${result.chunk.className}`;
      }

      return {
        label: `$(file-code) ${fileName}`,
        description: `${similarity}% ${contextInfo ? '· ' + contextInfo : ''}`,
        detail: `${dirPath} · Lines ${result.chunk.startLine}-${result.chunk.endLine} · ${preview}${
          result.chunk.content.length > 150 ? '...' : ''
        }`,
        result,
        alwaysShow: true,
      };
    });
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

interface ResultQuickPickItem extends vscode.QuickPickItem {
  result?: SearchResult;
  filePath?: string;
}
