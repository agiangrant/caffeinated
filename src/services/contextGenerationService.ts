import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import { CodeChunk } from '../types';
import { Logger } from '../utils/logger';

export interface EnrichedContext {
  summary: string;
  purpose: string;
  relatedConcepts: string[];
  usagePatterns: string[];
  dependencies: string[];
  fullContext: string;
}

export interface ContextGenerationProvider {
  generateContext(chunk: CodeChunk, relatedChunks?: CodeChunk[]): Promise<EnrichedContext>;
}

export class OllamaContextProvider implements ContextGenerationProvider {
  private client: AxiosInstance;
  private model: string;
  private keepAlive: string;
  private customPrompt?: string;

  constructor(endpoint: string, model: string, keepAlive: string = '1m', customPrompt?: string) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 60000,
    });
    this.model = model;
    this.keepAlive = keepAlive;
    this.customPrompt = customPrompt;

    Logger.debug(
      `OllamaContextProvider initialized with model: ${model}, endpoint: ${endpoint}, keep_alive: ${keepAlive}`
    );
    if (customPrompt) {
      Logger.debug(`Using custom prompt template`);
    }
  }

  async generateContext(chunk: CodeChunk, relatedChunks?: CodeChunk[]): Promise<EnrichedContext> {
    const prompt = this.buildPrompt(chunk, relatedChunks);
    const maxRetries = 3;
    const baseDelay = 1000;

    Logger.debug(
      `Generating context for chunk in ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
    );
    Logger.debug(`Prompt (first 500 chars): ${prompt.substring(0, 500)}...`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const response = await this.client.post('/api/generate', {
          model: this.model,
          prompt: prompt,
          stream: false,
          keep_alive: this.keepAlive,
          options: {
            temperature: 0.3,
            top_p: 0.9,
          },
        });

        const duration = Date.now() - startTime;
        Logger.debug(`Context generation completed in ${duration}ms`);

        if (response.data && response.data.response) {
          Logger.debug(
            `LLM Response (first 500 chars): ${response.data.response.substring(0, 500)}...`
          );
          const enriched = this.parseResponse(response.data.response, chunk);
          Logger.debug(`Parsed context - Summary: ${enriched.summary}`);
          return enriched;
        }

        throw new Error('Invalid response from Ollama');
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isRetryableError =
          axios.isAxiosError(error) &&
          (error.response?.status === 500 ||
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT');

        if (isRetryableError && !isLastAttempt) {
          const delay = baseDelay * Math.pow(2, attempt);
          Logger.warn(
            `Ollama context generation error (attempt ${attempt + 1}/${
              maxRetries + 1
            }), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (axios.isAxiosError(error)) {
          Logger.error(`Ollama context generation error: ${error.message}`, error);
        } else {
          Logger.error(`Context generation error`, error);
        }
        Logger.warn(`Using fallback context for ${chunk.filePath}:${chunk.startLine}`);
        return this.createFallbackContext(chunk);
      }
    }

    Logger.warn(
      `Failed to generate context after retries for ${chunk.filePath}:${chunk.startLine}`
    );
    return this.createFallbackContext(chunk);
  }

  private buildPrompt(chunk: CodeChunk, relatedChunks?: CodeChunk[]): string {
    if (this.customPrompt) {
      return this.customPrompt
        .replace('{code}', chunk.content)
        .replace('{language}', chunk.language)
        .replace('{fileName}', chunk.filePath.split('/').pop() || '')
        .replace('{filePath}', chunk.filePath)
        .replace('{startLine}', chunk.startLine.toString())
        .replace('{endLine}', chunk.endLine.toString());
    }

    let prompt = `You are a code analysis assistant. Extract concise semantic keywords and tags from code.

EXAMPLE 1:
CODE:
\`\`\`typescript
async function fetchUserProfile(userId: string): Promise<UserProfile> {
  const response = await fetch(\`/api/users/\${userId}\`);
  return response.json();
}
\`\`\`

ANALYSIS:
SUMMARY: async HTTP fetch user profile by ID
PURPOSE: retrieve user data from REST API endpoint
CONCEPTS: async/await, REST API, HTTP client, JSON parsing, promise-based, type-safe
USAGE: user authentication, profile retrieval, API integration
DEPENDENCIES: fetch, UserProfile

EXAMPLE 2:
CODE:
\`\`\`python
class DatabaseConnection:
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.connection = None

    def connect(self):
        self.connection = psycopg2.connect(host=self.host, port=self.port)
\`\`\`

ANALYSIS:
SUMMARY: PostgreSQL connection manager with configurable host/port
PURPOSE: database connection lifecycle management
CONCEPTS: OOP, constructor pattern, state management, connection pooling, configuration injection
USAGE: database initialization, connection setup, persistence layer
DEPENDENCIES: psycopg2

NOW ANALYZE THIS CODE:
\`\`\`${chunk.language}
${chunk.content}
\`\`\`

FILE: ${chunk.filePath}
LINES: ${chunk.startLine}-${chunk.endLine}
${chunk.functionName ? `FUNCTION: ${chunk.functionName}` : ''}
${chunk.className ? `CLASS: ${chunk.className}` : ''}
`;

    if (relatedChunks && relatedChunks.length > 0) {
      prompt += '\n\nRELATED CODE CONTEXT:\n';
      relatedChunks.forEach((related, index) => {
        prompt += `\n--- Related ${index + 1} (${related.filePath}) ---\n`;
        prompt += `\`\`\`${related.language}\n${related.content.substring(0, 500)}\`\`\`\n`;
      });
    }

    prompt += `

INSTRUCTIONS:
- Be concise and keyword-focused
- SUMMARY: 5-10 words describing what the code does
- PURPOSE: brief functional intent
- CONCEPTS: comma-separated technical keywords and patterns (6-10 items)
- USAGE: comma-separated use cases and scenarios
- DEPENDENCIES: libraries, types, external resources

ANALYSIS:
SUMMARY: `;

    return prompt;
  }

  private parseResponse(response: string, chunk: CodeChunk): EnrichedContext {
    const lines = response.split('\n').filter((line) => line.trim());
    const context: Partial<EnrichedContext> = {
      relatedConcepts: [],
      usagePatterns: [],
      dependencies: [],
    };

    for (const line of lines) {
      if (line.startsWith('SUMMARY:')) {
        context.summary = line.substring('SUMMARY:'.length).trim();
      } else if (line.startsWith('PURPOSE:')) {
        context.purpose = line.substring('PURPOSE:'.length).trim();
      } else if (line.startsWith('CONCEPTS:')) {
        const concepts = line.substring('CONCEPTS:'.length).trim();
        context.relatedConcepts = concepts
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
      } else if (line.startsWith('USAGE:')) {
        const usage = line.substring('USAGE:'.length).trim();
        context.usagePatterns = usage
          .split(',')
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
      } else if (line.startsWith('DEPENDENCIES:')) {
        const deps = line.substring('DEPENDENCIES:'.length).trim();
        context.dependencies = deps
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d.length > 0);
      }
    }

    // Build full context for embedding
    context.fullContext = this.buildFullContext(chunk, context);

    return context as EnrichedContext;
  }

  private buildFullContext(chunk: CodeChunk, context: Partial<EnrichedContext>): string {
    const parts: string[] = [];

    // Add file and location context
    parts.push(`File: ${chunk.filePath}`);
    if (chunk.functionName) {
      parts.push(`Function: ${chunk.functionName}`);
    }
    if (chunk.className) {
      parts.push(`Class: ${chunk.className}`);
    }

    // Add LLM-generated context
    if (context.summary) {
      parts.push(`Summary: ${context.summary}`);
    }
    if (context.purpose) {
      parts.push(`Purpose: ${context.purpose}`);
    }
    if (context.relatedConcepts && context.relatedConcepts.length > 0) {
      parts.push(`Concepts: ${context.relatedConcepts.join(', ')}`);
    }
    if (context.usagePatterns && context.usagePatterns.length > 0) {
      parts.push(`Usage: ${context.usagePatterns.join(', ')}`);
    }
    if (context.dependencies && context.dependencies.length > 0) {
      parts.push(`Dependencies: ${context.dependencies.join(', ')}`);
    }

    // Add the actual code
    parts.push('\nCode:');
    parts.push(chunk.content);

    return parts.join('\n');
  }

  private createFallbackContext(chunk: CodeChunk): EnrichedContext {
    // Simple fallback when LLM is unavailable
    const summary = chunk.functionName
      ? `Function ${chunk.functionName} in ${chunk.filePath}`
      : `Code in ${chunk.filePath} lines ${chunk.startLine}-${chunk.endLine}`;

    return {
      summary,
      purpose: 'Code implementation',
      relatedConcepts: chunk.className ? [chunk.className] : [],
      usagePatterns: [],
      dependencies: [],
      fullContext: `${summary}\n\n${chunk.content}`,
    };
  }
}

export class CustomContextProvider implements ContextGenerationProvider {
  private client: AxiosInstance;
  private model: string;
  private customPrompt?: string;

  constructor(endpoint: string, apiKey: string, model: string, customPrompt?: string) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 60000,
      headers: apiKey
        ? {
            Authorization: `Bearer ${apiKey}`,
          }
        : {},
    });
    this.model = model;
    this.customPrompt = customPrompt;

    Logger.debug(`CustomContextProvider initialized with model: ${model}, endpoint: ${endpoint}`);
    if (customPrompt) {
      Logger.debug(`Using custom prompt template`);
    }
  }

  async generateContext(chunk: CodeChunk, relatedChunks?: CodeChunk[]): Promise<EnrichedContext> {
    const prompt = this.buildPrompt(chunk, relatedChunks);
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    Logger.debug(
      `Generating context for chunk in ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
    );
    Logger.debug(`Prompt (first 500 chars): ${prompt.substring(0, 500)}...`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();

        // OpenAI-compatible chat completion format
        const response = await this.client.post('/v1/chat/completions', {
          model: this.model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: 500,
        });

        const duration = Date.now() - startTime;
        Logger.debug(`Context generation completed in ${duration}ms`);

        // Handle OpenAI-compatible response format
        let content: string | undefined;
        if (response.data?.choices?.[0]?.message?.content) {
          content = response.data.choices[0].message.content;
        } else if (response.data?.choices?.[0]?.text) {
          content = response.data.choices[0].text;
        }

        if (content) {
          Logger.debug(`LLM Response (first 500 chars): ${content.substring(0, 500)}...`);
          const enriched = this.parseResponse(content, chunk);
          Logger.debug(`Parsed context - Summary: ${enriched.summary}`);
          return enriched;
        }

        throw new Error('Invalid response from custom LLM endpoint');
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isRetryableError =
          axios.isAxiosError(error) &&
          (error.response?.status === 500 ||
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT');

        if (isRetryableError && !isLastAttempt) {
          const delay = baseDelay * Math.pow(2, attempt);
          Logger.warn(
            `Custom LLM context generation error (attempt ${attempt + 1}/${
              maxRetries + 1
            }), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (axios.isAxiosError(error)) {
          Logger.error(`Custom LLM context generation error: ${error.message}`, error);
        } else {
          Logger.error(`Context generation error`, error);
        }
        Logger.warn(`Using fallback context for ${chunk.filePath}:${chunk.startLine}`);
        return this.createFallbackContext(chunk);
      }
    }

    Logger.warn(
      `Failed to generate context after retries for ${chunk.filePath}:${chunk.startLine}`
    );
    return this.createFallbackContext(chunk);
  }

  private buildPrompt(chunk: CodeChunk, relatedChunks?: CodeChunk[]): string {
    if (this.customPrompt) {
      return this.customPrompt
        .replace('{code}', chunk.content)
        .replace('{language}', chunk.language)
        .replace('{fileName}', chunk.filePath.split('/').pop() || '')
        .replace('{filePath}', chunk.filePath)
        .replace('{startLine}', chunk.startLine.toString())
        .replace('{endLine}', chunk.endLine.toString());
    }

    let prompt = `You are a code analysis assistant. Extract concise semantic keywords and tags from code.

EXAMPLE 1:
CODE:
\`\`\`typescript
async function fetchUserProfile(userId: string): Promise<UserProfile> {
  const response = await fetch(\`/api/users/\${userId}\`);
  return response.json();
}
\`\`\`

ANALYSIS:
SUMMARY: async HTTP fetch user profile by ID
PURPOSE: retrieve user data from REST API endpoint
CONCEPTS: async/await, REST API, HTTP client, JSON parsing, promise-based, type-safe
USAGE: user authentication, profile retrieval, API integration
DEPENDENCIES: fetch, UserProfile

EXAMPLE 2:
CODE:
\`\`\`python
class DatabaseConnection:
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.connection = None

    def connect(self):
        self.connection = psycopg2.connect(host=self.host, port=self.port)
\`\`\`

ANALYSIS:
SUMMARY: PostgreSQL connection manager with configurable host/port
PURPOSE: database connection lifecycle management
CONCEPTS: OOP, constructor pattern, state management, connection pooling, configuration injection
USAGE: database initialization, connection setup, persistence layer
DEPENDENCIES: psycopg2

NOW ANALYZE THIS CODE:
\`\`\`${chunk.language}
${chunk.content}
\`\`\`

FILE: ${chunk.filePath}
LINES: ${chunk.startLine}-${chunk.endLine}
${chunk.functionName ? `FUNCTION: ${chunk.functionName}` : ''}
${chunk.className ? `CLASS: ${chunk.className}` : ''}
`;

    if (relatedChunks && relatedChunks.length > 0) {
      prompt += '\n\nRELATED CODE CONTEXT:\n';
      relatedChunks.forEach((related, index) => {
        prompt += `\n--- Related ${index + 1} (${related.filePath}) ---\n`;
        prompt += `\`\`\`${related.language}\n${related.content.substring(0, 500)}\`\`\`\n`;
      });
    }

    prompt += `

INSTRUCTIONS:
- Be concise and keyword-focused
- SUMMARY: 5-10 words describing what the code does
- PURPOSE: brief functional intent
- CONCEPTS: comma-separated technical keywords and patterns (6-10 items)
- USAGE: comma-separated use cases and scenarios
- DEPENDENCIES: libraries, types, external resources

ANALYSIS:
SUMMARY: `;

    return prompt;
  }

  private parseResponse(response: string, chunk: CodeChunk): EnrichedContext {
    const lines = response.split('\n').filter((line) => line.trim());
    const context: Partial<EnrichedContext> = {
      relatedConcepts: [],
      usagePatterns: [],
      dependencies: [],
    };

    for (const line of lines) {
      if (line.startsWith('SUMMARY:')) {
        context.summary = line.substring('SUMMARY:'.length).trim();
      } else if (line.startsWith('PURPOSE:')) {
        context.purpose = line.substring('PURPOSE:'.length).trim();
      } else if (line.startsWith('CONCEPTS:')) {
        const concepts = line.substring('CONCEPTS:'.length).trim();
        context.relatedConcepts = concepts
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
      } else if (line.startsWith('USAGE:')) {
        const usage = line.substring('USAGE:'.length).trim();
        context.usagePatterns = usage
          .split(',')
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
      } else if (line.startsWith('DEPENDENCIES:')) {
        const deps = line.substring('DEPENDENCIES:'.length).trim();
        context.dependencies = deps
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d.length > 0);
      }
    }

    context.fullContext = this.buildFullContext(chunk, context);

    return context as EnrichedContext;
  }

  private buildFullContext(chunk: CodeChunk, context: Partial<EnrichedContext>): string {
    const parts: string[] = [];

    parts.push(`File: ${chunk.filePath}`);
    if (chunk.functionName) {
      parts.push(`Function: ${chunk.functionName}`);
    }
    if (chunk.className) {
      parts.push(`Class: ${chunk.className}`);
    }

    if (context.summary) {
      parts.push(`Summary: ${context.summary}`);
    }
    if (context.purpose) {
      parts.push(`Purpose: ${context.purpose}`);
    }
    if (context.relatedConcepts && context.relatedConcepts.length > 0) {
      parts.push(`Concepts: ${context.relatedConcepts.join(', ')}`);
    }
    if (context.usagePatterns && context.usagePatterns.length > 0) {
      parts.push(`Usage: ${context.usagePatterns.join(', ')}`);
    }
    if (context.dependencies && context.dependencies.length > 0) {
      parts.push(`Dependencies: ${context.dependencies.join(', ')}`);
    }

    parts.push('\nCode:');
    parts.push(chunk.content);

    return parts.join('\n');
  }

  private createFallbackContext(chunk: CodeChunk): EnrichedContext {
    const summary = chunk.functionName
      ? `Function ${chunk.functionName} in ${chunk.filePath}`
      : `Code in ${chunk.filePath} lines ${chunk.startLine}-${chunk.endLine}`;

    return {
      summary,
      purpose: 'Code implementation',
      relatedConcepts: chunk.className ? [chunk.className] : [],
      usagePatterns: [],
      dependencies: [],
      fullContext: `${summary}\n\n${chunk.content}`,
    };
  }
}

export class ContextGenerationService {
  private provider: ContextGenerationProvider | null = null;
  private enabled: boolean = false;

  constructor() {
    this.updateProvider();
  }

  updateProvider(): void {
    const config = vscode.workspace.getConfiguration('caffeinated');
    this.enabled = config.get<boolean>('enableContextGeneration', true);

    Logger.debug(`Context generation enabled: ${this.enabled}`);

    if (!this.enabled) {
      this.provider = null;
      return;
    }

    const providerType = config.get<string>('contextGenerationProvider', 'ollama');
    const customPrompt = config.get<string>('contextGenerationPrompt', '');

    if (providerType === 'ollama') {
      const endpoint = config.get<string>('contextModelEndpoint', 'http://localhost:11434');
      const model = config.get<string>('contextModel', 'qwen2.5-coder:1.5b');
      const keepAlive = config.get<string>('contextModelKeepAlive', '1m');

      Logger.info(
        `Initializing Ollama context generation with model: ${model} at ${endpoint}, keep_alive: ${keepAlive}`
      );
      if (customPrompt) {
        Logger.info(`Using custom prompt template (${customPrompt.length} chars)`);
      }

      this.provider = new OllamaContextProvider(
        endpoint,
        model,
        keepAlive,
        customPrompt || undefined
      );
    } else {
      const endpoint = config.get<string>('customContextEndpoint', '');
      const apiKey = config.get<string>('customContextApiKey', '');
      const model = config.get<string>('customContextModel', 'gpt-3.5-turbo');

      if (!endpoint) {
        Logger.error('Custom context endpoint not configured');
        throw new Error('Custom context endpoint not configured');
      }

      Logger.info(`Initializing custom context generation with model: ${model} at ${endpoint}`);
      if (customPrompt) {
        Logger.info(`Using custom prompt template (${customPrompt.length} chars)`);
      }

      this.provider = new CustomContextProvider(endpoint, apiKey, model, customPrompt || undefined);
    }
  }

  async generateContext(
    chunk: CodeChunk,
    relatedChunks?: CodeChunk[]
  ): Promise<EnrichedContext | null> {
    if (!this.enabled || !this.provider) {
      return null;
    }

    try {
      return await this.provider.generateContext(chunk, relatedChunks);
    } catch (error) {
      Logger.error('Context generation failed', error);
      return null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async testConnection(): Promise<boolean> {
    if (!this.enabled || !this.provider) {
      return false;
    }

    try {
      const testChunk: CodeChunk = {
        id: 'test',
        filePath: 'test.ts',
        startLine: 0,
        endLine: 1,
        content: 'function test() { return true; }',
        language: 'typescript',
      };

      const result = await this.provider.generateContext(testChunk);
      return result !== null;
    } catch (error) {
      return false;
    }
  }
}
