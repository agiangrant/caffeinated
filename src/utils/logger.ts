import * as vscode from 'vscode';

export class Logger {
  private static outputChannel: vscode.OutputChannel;
  private static isDebugEnabled = false;

  static initialize(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Caffeinated');
    context.subscriptions.push(this.outputChannel);

    const config = vscode.workspace.getConfiguration('caffeinated');
    this.isDebugEnabled = config.get<boolean>('enableDebugLogging', false);
  }

  static updateDebugMode() {
    const config = vscode.workspace.getConfiguration('caffeinated');
    this.isDebugEnabled = config.get<boolean>('enableDebugLogging', false);
  }

  static debug(message: string, ...args: any[]) {
    if (this.isDebugEnabled) {
      const timestamp = new Date().toISOString();
      const formattedMessage = `[DEBUG ${timestamp}] ${message}`;
      this.outputChannel.appendLine(formattedMessage);

      if (args.length > 0) {
        this.outputChannel.appendLine(JSON.stringify(args, null, 2));
      }

      console.log(formattedMessage, ...args);
    }
  }

  static info(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[INFO ${timestamp}] ${message}`;
    this.outputChannel.appendLine(formattedMessage);

    if (args.length > 0) {
      this.outputChannel.appendLine(JSON.stringify(args, null, 2));
    }

    console.log(formattedMessage, ...args);
  }

  static warn(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[WARN ${timestamp}] ${message}`;
    this.outputChannel.appendLine(formattedMessage);

    if (args.length > 0) {
      this.outputChannel.appendLine(JSON.stringify(args, null, 2));
    }

    console.warn(formattedMessage, ...args);
  }

  static error(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[ERROR ${timestamp}] ${message}`;
    this.outputChannel.appendLine(formattedMessage);

    if (error) {
      if (error instanceof Error) {
        this.outputChannel.appendLine(`  Error: ${error.message}`);
        if (error.stack) {
          this.outputChannel.appendLine(`  Stack: ${error.stack}`);
        }
      } else {
        this.outputChannel.appendLine(JSON.stringify(error, null, 2));
      }
    }

    console.error(formattedMessage, error);
  }

  static show() {
    this.outputChannel.show();
  }

  static clear() {
    this.outputChannel.clear();
  }
}
