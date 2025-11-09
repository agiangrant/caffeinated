import * as crypto from 'crypto';
import { CodeChunk } from '../types';
import { Logger } from './logger';

export class CodeChunker {
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(chunkSize: number = 500, chunkOverlap: number = 50) {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  chunkFile(filePath: string, content: string, language: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];

    // Try to extract functions and classes for better chunking
    const structuredChunks = this.extractStructuredChunks(content, language);

    if (structuredChunks.length > 0) {
      Logger.debug(
        `Using structured chunking for ${filePath}: found ${structuredChunks.length} functions/classes`
      );
      // Use structured chunks (functions, classes) when available
      for (const structuredChunk of structuredChunks) {
        const chunkContent = lines
          .slice(structuredChunk.startLine, structuredChunk.endLine + 1)
          .join('\n');
        const contentHash = this.generateContentHash(chunkContent);
        chunks.push({
          id: this.generateChunkId(filePath, structuredChunk.startLine, structuredChunk.endLine),
          filePath,
          startLine: structuredChunk.startLine,
          endLine: structuredChunk.endLine,
          content: chunkContent,
          contentHash,
          language,
          functionName: structuredChunk.functionName,
          className: structuredChunk.className,
        });
      }
    } else {
      Logger.debug(
        `Using line-based chunking for ${filePath}: no structured elements found for language ${language}`
      );
      // Fall back to simple line-based chunking
      let startLine = 0;
      while (startLine < lines.length) {
        const endLine = Math.min(startLine + this.chunkSize, lines.length);
        const chunkContent = lines.slice(startLine, endLine).join('\n');

        if (chunkContent.trim().length > 0) {
          const contentHash = this.generateContentHash(chunkContent);
          chunks.push({
            id: this.generateChunkId(filePath, startLine, endLine - 1),
            filePath,
            startLine,
            endLine: endLine - 1,
            content: chunkContent,
            contentHash,
            language,
          });
        }

        startLine += this.chunkSize - this.chunkOverlap;
      }
    }

    return chunks;
  }

  private extractStructuredChunks(
    content: string,
    language: string
  ): Array<{
    startLine: number;
    endLine: number;
    functionName?: string;
    className?: string;
  }> {
    const chunks: Array<{
      startLine: number;
      endLine: number;
      functionName?: string;
      className?: string;
    }> = [];

    const lines = content.split('\n');

    // Simple pattern matching for common languages
    // This is a basic implementation - could be improved with proper AST parsing
    // Might be able to just ignore comments, but then what about strings?
    const patterns = this.getLanguagePatterns(language);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for function definitions
      for (const pattern of patterns.functions) {
        const match = line.match(pattern);
        if (match) {
          const functionName = match[1];
          const { endLine } = this.findBlockEnd(lines, i, language);
          chunks.push({
            startLine: i,
            endLine,
            functionName,
          });
          i = endLine; // Skip to end of function
          break;
        }
      }

      // Check for class definitions
      for (const pattern of patterns.classes) {
        const match = line.match(pattern);
        if (match) {
          const className = match[1];
          const { endLine } = this.findBlockEnd(lines, i, language);
          chunks.push({
            startLine: i,
            endLine,
            className,
          });
          i = endLine; // Skip to end of class
          break;
        }
      }
    }

    return chunks;
  }

  private getLanguagePatterns(language: string): {
    functions: RegExp[];
    classes: RegExp[];
  } {
    const patterns: Record<string, { functions: RegExp[]; classes: RegExp[] }> = {
      typescript: {
        functions: [
          /function\s+(\w+)/,
          /const\s+(\w+)\s*=\s*\(/,
          /(\w+)\s*\([^)]*\)\s*{/,
          /async\s+function\s+(\w+)/,
        ],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /type\s+(\w+)/],
      },
      typescriptreact: {
        functions: [
          /function\s+(\w+)/,
          /const\s+(\w+)\s*=\s*\(/,
          /(\w+)\s*\([^)]*\)\s*{/,
          /async\s+function\s+(\w+)/,
          /export\s+(?:default\s+)?function\s+(\w+)/,
          /export\s+const\s+(\w+)\s*=\s*\(/,
        ],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /type\s+(\w+)/],
      },
      javascript: {
        functions: [
          /function\s+(\w+)/,
          /const\s+(\w+)\s*=\s*\(/,
          /(\w+)\s*\([^)]*\)\s*{/,
          /async\s+function\s+(\w+)/,
        ],
        classes: [/class\s+(\w+)/],
      },
      javascriptreact: {
        functions: [
          /function\s+(\w+)/,
          /const\s+(\w+)\s*=\s*\(/,
          /(\w+)\s*\([^)]*\)\s*{/,
          /async\s+function\s+(\w+)/,
          /export\s+(?:default\s+)?function\s+(\w+)/,
          /export\s+const\s+(\w+)\s*=\s*\(/,
        ],
        classes: [/class\s+(\w+)/],
      },
      python: {
        functions: [/def\s+(\w+)/],
        classes: [/class\s+(\w+)/],
      },
      java: {
        functions: [/(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /enum\s+(\w+)/],
      },
      go: {
        functions: [/func\s+(?:\([^)]*\)\s*)?(\w+)/],
        classes: [/type\s+(\w+)\s+struct/, /type\s+(\w+)\s+interface/],
      },
      rust: {
        functions: [
          /fn\s+(\w+)/, // fn function_name
          /pub\s+fn\s+(\w+)/, // pub fn function_name
          /pub\s*\(\s*crate\s*\)\s*fn\s+(\w+)/, // pub(crate) fn function_name
          /async\s+fn\s+(\w+)/, // async fn function_name
          /const\s+fn\s+(\w+)/, // const fn function_name
          /unsafe\s+fn\s+(\w+)/, // unsafe fn function_name
        ],
        classes: [
          /struct\s+(\w+)/, // struct Name
          /enum\s+(\w+)/, // enum Name
          /trait\s+(\w+)/, // trait Name
          /impl\s+(?:<[^>]*>\s+)?(\w+)/, // impl Name or impl<T> Name
          /type\s+(\w+)/, // type alias
        ],
      },
      cpp: {
        functions: [
          /(?:void|int|bool|float|double|auto|const|static|virtual|inline)\s+(\w+)\s*\(/,
          /(\w+)\s*\([^)]*\)\s*(?:const)?\s*{/,
        ],
        classes: [/class\s+(\w+)/, /struct\s+(\w+)/, /namespace\s+(\w+)/],
      },
      c: {
        functions: [/(?:void|int|bool|float|double|char|const|static|inline)\s+(\w+)\s*\(/],
        classes: [/struct\s+(\w+)/, /typedef\s+struct\s+(\w+)/],
      },
      csharp: {
        functions: [
          /(?:public|private|protected|internal)?\s*(?:static|async|virtual|override)?\s*\w+\s+(\w+)\s*\(/,
        ],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /struct\s+(\w+)/, /enum\s+(\w+)/],
      },
      php: {
        functions: [/function\s+(\w+)/, /(?:public|private|protected)\s+function\s+(\w+)/],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /trait\s+(\w+)/],
      },
      ruby: {
        functions: [/def\s+(\w+)/, /def\s+self\.(\w+)/],
        classes: [/class\s+(\w+)/, /module\s+(\w+)/],
      },
      swift: {
        functions: [/func\s+(\w+)/, /(?:public|private|internal|fileprivate)\s+func\s+(\w+)/],
        classes: [/class\s+(\w+)/, /struct\s+(\w+)/, /enum\s+(\w+)/, /protocol\s+(\w+)/],
      },
      kotlin: {
        functions: [/fun\s+(\w+)/, /(?:public|private|internal|protected)?\s*fun\s+(\w+)/],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /object\s+(\w+)/, /enum\s+class\s+(\w+)/],
      },
      html: {
        functions: [
          /<script[^>]*>/, // Script tags
          /function\s+(\w+)/, // JavaScript functions in script tags
        ],
        classes: [
          /class="([^"]+)"/, // CSS classes
          /id="([^"]+)"/, // Element IDs
        ],
      },
      css: {
        functions: [],
        classes: [
          /\.([a-zA-Z][\w-]*)/, // CSS class selectors
          /#([a-zA-Z][\w-]*)/, // CSS ID selectors
        ],
      },
      scss: {
        functions: [
          /@mixin\s+(\w+)/, // SCSS mixins
          /@function\s+(\w+)/, // SCSS functions
        ],
        classes: [
          /\.([a-zA-Z][\w-]*)/, // CSS class selectors
          /#([a-zA-Z][\w-]*)/, // CSS ID selectors
          /%([a-zA-Z][\w-]*)/, // SCSS placeholders
        ],
      },
      sass: {
        functions: [
          /@mixin\s+(\w+)/, // Sass mixins
          /@function\s+(\w+)/, // Sass functions
        ],
        classes: [
          /\.([a-zA-Z][\w-]*)/, // CSS class selectors
          /#([a-zA-Z][\w-]*)/, // CSS ID selectors
          /%([a-zA-Z][\w-]*)/, // Sass placeholders
        ],
      },
      vue: {
        functions: [
          /function\s+(\w+)/,
          /const\s+(\w+)\s*=\s*\(/,
          /(\w+)\s*\([^)]*\)\s*{/,
          /export\s+(?:default\s+)?function\s+(\w+)/,
        ],
        classes: [/class\s+(\w+)/, /interface\s+(\w+)/, /type\s+(\w+)/],
      },
    };

    return patterns[language] || { functions: [], classes: [] };
  }

  private findBlockEnd(lines: string[], startLine: number, language: string): { endLine: number } {
    let braceCount = 0;
    let inBlock = false;

    // For Python, use indentation, should ignore comments... we'll figure that out later
    if (language === 'python') {
      const startIndent = lines[startLine].search(/\S/);
      for (let i = startLine + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) {
          continue;
        }

        const indent = lines[i].search(/\S/);
        if (indent <= startIndent && line.length > 0) {
          return { endLine: i - 1 };
        }
      }
      return { endLine: lines.length - 1 };
    }

    // For brace-based languages, may need to ignore comments and strings at some point but AST parsing is probably overkill for the current use case
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          inBlock = true;
        } else if (char === '}') {
          braceCount--;
          if (inBlock && braceCount === 0) {
            return { endLine: i };
          }
        }
      }
    }

    return { endLine: Math.min(startLine + this.chunkSize, lines.length - 1) };
  }

  private generateChunkId(filePath: string, startLine: number, endLine: number): string {
    const data = `${filePath}:${startLine}:${endLine}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  setChunkSize(size: number): void {
    this.chunkSize = size;
  }

  setChunkOverlap(overlap: number): void {
    this.chunkOverlap = overlap;
  }
}
