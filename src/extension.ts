import * as vscode from 'vscode';
import { VectorDatabase } from './database/vectorDatabase';
import { EmbeddingService } from './services/embeddingService';
import { ContextGenerationService } from './services/contextGenerationService';
import { IndexingService } from './services/indexingService';
import { SearchService } from './services/searchService';
import { CodeChunker } from './utils/codeChunker';
import { SearchCommand } from './commands/searchCommand';
import { QuickSearchCommand } from './commands/quickSearchCommand';
import { IndexCommand } from './commands/indexCommand';
import { Logger } from './utils/logger';

let vectorDatabase: VectorDatabase;
let embeddingService: EmbeddingService;
let contextGenerationService: ContextGenerationService;
let indexingService: IndexingService;
let searchService: SearchService;
let fileWatcher: vscode.FileSystemWatcher;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize logger first
  Logger.initialize(context);
  Logger.info('='.repeat(50));
  Logger.info('CAFFEINATED EXTENSION IS ACTIVATING');
  Logger.info('='.repeat(50));

  vscode.window.showInformationMessage('Caffeinated: Extension is loading...');

  let initializationSucceeded = false;
  let initializationError: string = '';

  // Initialize services
  try {
    console.log('Starting service initialization...');
    await initializeServices(context);
    console.log('Service initialization completed successfully');
    initializationSucceeded = true;
    vscode.window.showInformationMessage('Caffeinated: Ready! Use commands from the palette.');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    initializationError = `${errorMsg}\n\nStack: ${errorStack}`;

    console.error('='.repeat(50));
    console.error('CAFFEINATED INITIALIZATION FAILED');
    console.error('='.repeat(50));
    console.error('Error:', errorMsg);
    console.error('Stack:', errorStack);
    console.error('='.repeat(50));

    vscode.window
      .showErrorMessage(
        `Caffeinated initialization failed: ${errorMsg}`,
        'Show Full Error',
        'View Logs'
      )
      .then((selection) => {
        if (selection === 'Show Full Error') {
          vscode.workspace
            .openTextDocument({
              content: initializationError,
              language: 'plaintext',
            })
            .then((doc) => vscode.window.showTextDocument(doc));
        } else if (selection === 'View Logs') {
          vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        }
      });
    // Don't return, still register commands with error handlers
  }

  // Create commands and register commands
  const searchCommand = initializationSucceeded ? new SearchCommand(searchService) : null;
  const quickSearchCommand = initializationSucceeded ? new QuickSearchCommand(searchService) : null;
  const indexCommand = initializationSucceeded
    ? new IndexCommand(indexingService, vectorDatabase)
    : null;

  const showInitError = () => {
    vscode.window
      .showErrorMessage('Caffeinated: Extension not initialized', 'Show Error Details')
      .then((selection) => {
        if (selection === 'Show Error Details') {
          vscode.workspace
            .openTextDocument({
              content: initializationError || 'Unknown initialization error',
              language: 'plaintext',
            })
            .then((doc) => vscode.window.showTextDocument(doc));
        }
      });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.search', () => {
      if (!searchCommand) {
        showInitError();
        return;
      }
      searchCommand.execute();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.quickSearch', () => {
      if (!quickSearchCommand) {
        showInitError();
        return;
      }
      quickSearchCommand.execute();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.indexWorkspace', () => {
      if (!indexCommand) {
        showInitError();
        return;
      }
      indexCommand.indexWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.clearIndex', () => {
      if (!indexCommand) {
        showInitError();
        return;
      }
      indexCommand.clearIndex();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.reindexWorkspace', () => {
      if (!indexCommand) {
        showInitError();
        return;
      }
      indexCommand.reindexWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.showStatus', () => {
      if (!indexCommand) {
        showInitError();
        return;
      }
      indexCommand.showStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caffeinated.showLogs', () => {
      Logger.show();
    })
  );

  // File watchers for auto-indexing after initialization
  if (initializationSucceeded) {
    setupFileWatchers(context);
  }

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('caffeinated')) {
        Logger.updateDebugMode();
        handleConfigurationChange();
      }
    })
  );

  // Auto-index on first use
  if (initializationSucceeded && vectorDatabase) {
    const stats = await vectorDatabase.getStats();
    if (stats.totalChunks === 0) {
      Logger.info('First time setup detected - starting auto-indexing');

      const connected = await embeddingService.testConnection();
      if (!connected) {
        const config = vscode.workspace.getConfiguration('caffeinated');
        const provider = config.get<string>('embeddingProvider', 'ollama');

        const response = await vscode.window.showWarningMessage(
          `Caffeinated: Cannot connect to ${
            provider === 'ollama' ? 'Ollama' : 'embedding service'
          }. Please ensure it's running before indexing.\n\n` +
            (provider === 'ollama'
              ? 'Run: ollama pull nomic-embed-text'
              : 'Check your custom endpoint configuration.'),
          'Index Anyway',
          'Open Settings',
          'Cancel'
        );

        if (response === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'caffeinated');
          return;
        } else if (response === 'Cancel') {
          vscode.window.showInformationMessage(
            'Caffeinated: You can index later using "Caffeinated: Index Workspace" from the command palette.'
          );
          return;
        }
      }

      vscode.commands.executeCommand('caffeinated.indexWorkspace');
    }
  }
}

async function initializeServices(context: vscode.ExtensionContext): Promise<void> {
  const storagePath = context.globalStorageUri.fsPath;

  vectorDatabase = new VectorDatabase(storagePath);
  embeddingService = new EmbeddingService();

  const connected = await embeddingService.testConnection();
  if (!connected) {
    const config = vscode.workspace.getConfiguration('caffeinated');
    const provider = config.get<string>('embeddingProvider', 'ollama');

    if (provider === 'ollama') {
      vscode.window.showWarningMessage(
        'Caffeinated: Cannot connect to Ollama. Make sure Ollama is running and the model is pulled. Run: ollama pull nomic-embed-text'
      );
    } else {
      vscode.window.showWarningMessage(
        'Caffeinated: Cannot connect to custom embedding endpoint. Check your configuration.'
      );
    }
  }

  const dimensions = embeddingService.getDimensions();
  vectorDatabase.setDimensions(dimensions);

  contextGenerationService = new ContextGenerationService();

  if (contextGenerationService.isEnabled()) {
    const contextConnected = await contextGenerationService.testConnection();
    if (!contextConnected) {
      vscode.window.showWarningMessage(
        'Caffeinated: Context generation enabled but cannot connect to LLM. Make sure the model is running. Run: ollama pull qwen2.5-coder:1.5b'
      );
    } else {
      vscode.window.showInformationMessage(
        'Caffeinated: Context generation enabled! Embeddings will be enriched with semantic information.'
      );
    }
  }

  // Initialize code chunker
  const config = vscode.workspace.getConfiguration('caffeinated');
  const chunkSize = config.get<number>('chunkSize', 500);
  const chunkOverlap = config.get<number>('chunkOverlap', 50);
  const codeChunker = new CodeChunker(chunkSize, chunkOverlap);

  indexingService = new IndexingService(
    vectorDatabase,
    embeddingService,
    contextGenerationService,
    codeChunker
  );

  searchService = new SearchService(vectorDatabase, embeddingService);
}

function setupFileWatchers(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('caffeinated');
  const indexOnSave = config.get<boolean>('indexOnSave', true);

  if (!indexOnSave) {
    return;
  }

  // Watch for file changes
  fileWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{ts,js,py,java,go,cpp,c,h,hpp,cs,rb,php,swift,kt,rs}'
  );

  fileWatcher.onDidCreate(async (uri) => {
    try {
      await indexingService.indexFile(uri);
    } catch (error) {
      console.error(`Error indexing new file ${uri.fsPath}:`, error);
    }
  });

  fileWatcher.onDidChange(async (uri) => {
    try {
      await indexingService.indexFile(uri);
    } catch (error) {
      console.error(`Error re-indexing file ${uri.fsPath}:`, error);
    }
  });

  fileWatcher.onDidDelete(async (uri) => {
    try {
      await indexingService.removeFile(uri);
    } catch (error) {
      console.error(`Error removing file ${uri.fsPath}:`, error);
    }
  });

  context.subscriptions.push(fileWatcher);
}

function handleConfigurationChange(): void {
  // Update embedding service
  embeddingService.updateProvider();

  // Can probably remove these lines
  const config = vscode.workspace.getConfiguration('caffeinated');
  const _chunkSize = config.get<number>('chunkSize', 500);
  const _chunkOverlap = config.get<number>('chunkOverlap', 50);

  vscode.window
    .showInformationMessage(
      'Caffeinated: Configuration changed. Please reload the window for changes to take effect.',
      'Reload'
    )
    .then((action) => {
      if (action === 'Reload') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

export function deactivate() {
  if (vectorDatabase) {
    vectorDatabase.close();
  }

  if (fileWatcher) {
    fileWatcher.dispose();
  }
}
