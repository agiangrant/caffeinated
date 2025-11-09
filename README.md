# Caffeinated - Code Search

Caffeinated is a VSCodium/VSCode extension that provides semantic, keyword, and fuzzy code search powered by local embeddings and vector similarity. Search your codebase using natural language queries and find code based on meaning, not just keywords.

## Features

- **Semantic Code Search**: Search your codebase using natural language queries or whatever you want really.
- **Hybrid Search**: Combines semantic similarity, keyword search, and fuzzy filename matching using Reciprocal Rank Fusion (RRF).
- **Quick Search**: Instant access with `Cmd+K Cmd+P` shows open files and similar code to your cursor position
- **LLM-Powered Context Enrichment**: Optionally use a small LLM to generate semantic context for dramatically improved search quality
- **Local Embeddings**: All embeddings are generated and stored locally using Ollama or custom endpoints
- **Smart Chunking**: Intelligently chunks code by functions and classes for better search results
- **Function-Level Search**: Find similar code based on the specific function at your cursor position
- **Auto-Indexing**: Automatically re-indexes files when they're saved
- **Multiple Provider Support**: Works with Ollama (default), TabbyML, OpenAI-compatible APIs, and custom endpoints
- **Fast Vector Search**: Uses SQLite with in-memory vector similarity for quick results

## Requirements

### Option 1: Ollama (Recommended for Local Development)

**Best for**: Developers who want 100% local, privacy-focused semantic search with no API costs.

1. **Install Ollama**:

   ```bash
   # macOS/Linux
   curl -fsSL https://ollama.ai/install.sh | sh

   # Or download from https://ollama.ai
   ```

2. **Pull the embedding model**:

   ```bash
   ollama pull nomic-embed-text
   ```

   This is a high-quality 137M parameter embedding model optimized for code.

3. **(Optional but Recommended) Pull a small LLM for context generation**:

   ```bash
   ollama pull qwen2.5-coder:1.5b
   ```

   This 1.5B parameter model generates semantic descriptions, related concepts, and usage patterns for each code chunk, significantly improving search quality.

4. **Configure VSCode Settings**:

   ```json
   {
     "caffeinated.embeddingProvider": "ollama",
     "caffeinated.ollamaEndpoint": "http://localhost:11434",
     "caffeinated.ollamaModel": "nomic-embed-text",
     "caffeinated.ollamaKeepAlive": "30m",

     // Optional: Disable with `false` for embeddings only
     "caffeinated.enableContextGeneration": true, // default
     "caffeinated.contextGenerationProvider": "ollama",
     "caffeinated.contextModel": "qwen2.5-coder:1.5b"
   }
   ```

### Option 2: TabbyML (Local Code Intelligence Platform)

**Best for**: Teams already using TabbyML for code completion who want to leverage the same infrastructure.

1. **Install and run TabbyML**:

   ```bash
   # Using Docker (use --device metal for Apple Silicon)
   docker run -it --gpus all -p 8080:8080 \
     -v $HOME/.tabby:/data \
     tabbyml/tabby serve --device cuda --model StarCoder-1B

   # Or download from https://tabby.tabbyml.com <- recommended for performance
   ```

2. **Configure VSCode Settings**:
   ```json
   {
     "caffeinated.embeddingProvider": "custom",
     "caffeinated.customEndpoint": "http://localhost:8080",
     "caffeinated.customApiKey": "" // Leave empty if TabbyML doesn't require auth
   }
   ```

**Note**: TabbyML's embedding API endpoint varies by version. Check your TabbyML documentation for the correct endpoint format.

### Option 3: OpenAI-Compatible APIs (Cloud or Self-Hosted)

**Best for**: Teams using hosted LLM services or running their own OpenAI-compatible API servers.

Supported providers:

- OpenAI (cloud)
- Azure OpenAI (cloud)
- LocalAI (self-hosted)
- Text-generation-webui with OpenAI extension (self-hosted)
- vLLM (self-hosted)
- Any OpenAI-compatible API

**Configuration for OpenAI**:

```json
{
  "caffeinated.embeddingProvider": "custom",
  "caffeinated.customEndpoint": "https://api.openai.com",
  "caffeinated.customApiKey": "sk-...",

  // Optional: Context generation with GPT
  "caffeinated.enableContextGeneration": true,
  "caffeinated.contextGenerationProvider": "custom",
  "caffeinated.customContextEndpoint": "https://api.openai.com",
  "caffeinated.customContextApiKey": "sk-...",
  "caffeinated.customContextModel": "gpt-3.5-turbo"
}
```

**Configuration for Self-Hosted OpenAI-Compatible API**:

```json
{
  "caffeinated.embeddingProvider": "custom",
  "caffeinated.customEndpoint": "http://localhost:8000", // Your API server
  "caffeinated.customApiKey": "", // Optional, depending on your setup

  "caffeinated.enableContextGeneration": true,
  "caffeinated.contextGenerationProvider": "custom",
  "caffeinated.customContextEndpoint": "http://localhost:8000",
  "caffeinated.customContextModel": "your-model-name"
}
```

## Getting Started

1. **Install the extension**

2. **Choose and configure your provider** (see Requirements section above)

3. **Index your workspace**:

   - Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P` / `F1`)
   - Run: `Caffeinated: Index Workspace`
   - Wait for indexing to complete. First-time indexing may take a few minutes. Seriously, go eat lunch, talk a walk, sleep. Larger codebases will take a while. Maybe purchase a fan or an ice brick for your poor machine.

4. **Start searching**:
   - **Quick Search**: Press `Cmd+K Cmd+P` (or `Ctrl+K Ctrl+P` on Windows/Linux)
     - Shows open files and similar code to your cursor position
     - Start typing to search semantically
   - **Full Search**: Open Command Palette → `Caffeinated: Search Code Semantically`
     - Enter your query (e.g., "function that handles user authentication")
     - Select from the results to jump to the code

## Commands

- `Caffeinated: Quick Search` - Quick access to search (default: `Cmd+K Cmd+P`)
- `Caffeinated: Search Code Semantically` - Open full semantic search dialog
- `Caffeinated: Index Workspace` - Index all code files in the workspace
- `Caffeinated: Reindex Workspace` - Clear and rebuild the entire index
- `Caffeinated: Clear Index` - Clear the entire index
- `Caffeinated: Show Index Status` - Show indexing statistics
- `Caffeinated: Show Debug Logs` - Show debug logs in Output panel

## Configuration

All settings can be configured in VSCode Settings (UI) or in your `settings.json`.

### Search Settings

Here is a good explanation on RRF if you just want the rundown https://github.com/drittich/reciprocal-rank-fusion which is helpful if you want to customize the `caffeinated.rrf.k` value in the configuration.

```json
{
  "caffeinated.searchMode": "hybrid", // "hybrid", "semantic", or "keyword"
  "caffeinated.rrf.k": 60 // RRF constant for hybrid search (lower = more weight to top results)
}
```

**Search Modes**:

- `hybrid` (default): Combines semantic similarity, keyword search, and fuzzy filename matching using Reciprocal Rank Fusion (best results)
- `semantic`: Pure vector similarity search (best for conceptual queries)
- `keyword`: Pure keyword/lexical search (best for exact identifiers)

### Embedding Provider Settings

**For Ollama**:

```json
{
  "caffeinated.embeddingProvider": "ollama",
  "caffeinated.ollamaEndpoint": "http://localhost:11434",
  "caffeinated.ollamaModel": "nomic-embed-text",
  "caffeinated.ollamaKeepAlive": "30m", // Keep model loaded for faster subsequent requests
  "caffeinated.embeddingBatchSize": 10 // Concurrent embeddings during indexing
}
```

**For Custom/TabbyML/OpenAI**:

```json
{
  "caffeinated.embeddingProvider": "custom",
  "caffeinated.customEndpoint": "http://localhost:8080", // Your API endpoint
  "caffeinated.customApiKey": "", // API key (optional)
  "caffeinated.embeddingBatchSize": 10
}
```

### Context Generation Settings (Advanced)

Enable LLM-powered context enrichment for significantly better search quality. When enabled, a small LLM analyzes each code chunk and generates semantic context before embedding.

**For Ollama**:

```json
{
  "caffeinated.enableContextGeneration": true,
  "caffeinated.contextGenerationProvider": "ollama",
  "caffeinated.contextModelEndpoint": "http://localhost:11434",
  "caffeinated.contextModel": "qwen2.5-coder:1.5b", // Small, fast LLM
  "caffeinated.contextModelKeepAlive": "1m", // Lower keep-alive during indexing
  "caffeinated.contextGenerationBatchSize": 10 // Concurrent context generation
}
```

**For Custom/OpenAI-Compatible APIs**:

```json
{
  "caffeinated.enableContextGeneration": true,
  "caffeinated.contextGenerationProvider": "custom",
  "caffeinated.customContextEndpoint": "https://api.openai.com",
  "caffeinated.customContextApiKey": "sk-...",
  "caffeinated.customContextModel": "gpt-3.5-turbo",
  "caffeinated.contextGenerationBatchSize": 10
}
```

**What context generation provides**:

- **Summary**: Concise description of what the code does
- **Purpose**: Primary functionality and use case
- **Related Concepts**: Programming patterns, techniques used
- **Usage Patterns**: Common ways this code is used
- **Dependencies**: Key imports and dependencies

This enriched context is embedded alongside the code, making searches much more semantic and accurate.

**Custom Prompts**:
You can customize the prompt template used for context generation:

```json
{
  "caffeinated.contextGenerationPrompt": "Analyze this {language} code from {fileName}:\n\n{code}\n\nProvide a brief summary and key concepts."
}
```

Available placeholders: `{code}`, `{language}`, `{fileName}`, `{filePath}`, `{startLine}`, `{endLine}`

### Indexing Settings

```json
{
  "caffeinated.indexOnSave": true, // Auto-reindex files when saved
  "caffeinated.maxFileSize": 1048576, // Skip files larger than 1MB
  "caffeinated.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/out/**",
    "**/.git/**",
    "**/build/**",
    "**/*.min.js"
  ]
}
```

### Code Chunking Settings

```json
{
  "caffeinated.chunkSize": 500, // Lines per chunk
  "caffeinated.chunkOverlap": 50 // Overlapping lines between chunks
}
```

### Debug Settings

```json
{
  "caffeinated.enableDebugLogging": false // Enable detailed logging to Output panel
}
```

## How It Works

### Indexing Process

**Basic Mode (Context Generation Disabled)**:

1. **File Discovery**: Scans workspace for supported code files (respects `.gitignore` and exclude patterns)
2. **Smart Chunking**: Splits files into meaningful chunks based on language syntax:
   - Functions and methods
   - Classes and interfaces
   - Fixed-size blocks with overlap (fallback)
3. **Embedding**: Each chunk is converted to a vector embedding using your configured provider
4. **Storage**: Embeddings are stored in a local SQLite database with FTS5 index for keyword search
5. **Incremental Updates**: Only re-indexes changed chunks (based on content hash)

**Enhanced Mode (Context Generation Enabled)**:

1. **File Discovery**: Same as basic mode
2. **Smart Chunking**: Same as basic mode
3. **Context Generation**: A small LLM analyzes each chunk and generates:
   - Summary (what the code does)
   - Purpose (why it exists)
   - Related concepts (patterns, techniques)
   - Usage patterns (how it's used)
   - Dependencies (imports, types)
4. **Enriched Embedding**: The combined code + context is embedded for richer semantic search
5. **Storage**: Same as basic mode with additional metadata
6. **Incremental Updates**: Same as basic mode

### Search Process

**Hybrid Search (Default)**:

1. **Query Processing**: Your natural language query is processed
2. **Parallel Search**:
   - **Semantic**: Query is embedded and compared with chunk embeddings using cosine similarity
   - **Keyword**: FTS5 full-text search with BM25 ranking
   - **Fuzzy**: Fuzzy filename matching
3. **Reciprocal Rank Fusion (RRF)**: Combines results from all three methods using RRF algorithm
4. **Results**: Displays merged, ranked results with similarity scores

**Semantic-Only Search**:

- Query is embedded and matched against chunk embeddings using cosine similarity

**Keyword-Only Search**:

- Uses [SQLite FTS5](https://sqlite.org/fts5.html) full-text search with BM25 ranking

## Performance Tips

### Indexing Performance

- **Initial Indexing**: First index may take a few minutes depending on codebase size
- **Batch Size**: Increase `embeddingBatchSize` (default: 10) for faster indexing if you have enough RAM
- **Keep-Alive**: Set `ollamaKeepAlive` to `30m` or higher to keep models loaded in memory
- **Exclude Patterns**: Configure exclude patterns to skip large files, dependencies, and build artifacts
- **Context Generation**: Start without it for faster indexing, enable later for better search quality
- **Incremental Updates**: Only changed files are re-indexed on save

### Search Performance

- **Quick Search**: Use `Cmd+K Cmd+P` for instant access with cached results
- **Hybrid Mode**: Provides best results but is slightly slower than semantic-only mode
- **Search Mode**: Switch to `semantic` or `keyword` mode if you need faster searches
- **Model Choice**: Smaller embedding models = faster searches (but may reduce accuracy)

### Hardware Recommendations

- **Minimum**: 8GB RAM, 2GB free disk space
- **Recommended**: 16GB RAM, 5GB free disk space
- **Optimal**: 32GB RAM, GPU (for faster Ollama inference). Laptops are still going to take a while.

## Use Cases

- **Find Similar Code**: "function that parses JSON responses"
- **Locate Functionality**: "code that handles file uploads"
- **Discover Patterns**: "error handling middleware"
- **Navigate Unfamiliar Codebases**: "authentication logic"
- **Code Reuse**: Find existing implementations before writing new code
- **Refactoring**: Find all similar implementations across the codebase
- **Learning**: Discover how specific patterns are implemented in your project
- **Code Review**: Find related code that might be affected by changes

## Supported Languages

The extension supports intelligent chunking and search for:

- **TypeScript** (.ts, .tsx) - Functions, classes, interfaces, React components
- **JavaScript** (.js, .jsx) - Functions, classes, React components
- **Python** (.py) - Functions, classes, methods
- **Java** (.java) - Classes, methods, interfaces
- **Go** (.go) - Functions, structs, interfaces
- **C/C++** (.c, .cpp, .h, .hpp) - Functions, classes, structs
- **C#** (.cs) - Classes, methods, interfaces
- **Ruby** (.rb) - Methods, classes, modules
- **PHP** (.php) - Functions, classes, methods
- **Swift** (.swift) - Functions, classes, protocols
- **Kotlin** (.kt) - Functions, classes, interfaces
- **Rust** (.rs) - Functions, structs, traits, impls
- **HTML** (.html, .htm) - Script tags, elements
- **CSS/SCSS/Sass** (.css, .scss, .sass) - Selectors, mixins, functions
- **Vue** (.vue) - Single-file components

## Privacy & Security

### Data Storage

- **100% Local with Ollama**: All embeddings are generated and stored locally on your machine
- **No Telemetry**: This extension does not collect or send any usage data
- **Your Control**: The index database is stored in your VSCode global storage (`~/.vscode/globalStorage` or similar)
- **No External Services**: When using Ollama, no data leaves your machine

### With Custom Endpoints

- **You Choose**: If using custom endpoints (OpenAI, TabbyML, etc.), you control where data is sent
- **API Keys**: Stored in VSCode settings (consider using workspace settings for team configurations)
- **Self-Hosted Options**: Use LocalAI, vLLM, or other self-hosted solutions for complete privacy

## Troubleshooting

### Ollama Issues

**"Cannot connect to Ollama"**:

- Make sure Ollama is running: `ollama serve` (or check if it's running as a service)
- Verify the model is pulled: `ollama list` and `ollama pull nomic-embed-text` if needed
- Check the endpoint in settings: Default is `http://localhost:11434`
- Test manually: `curl http://localhost:11434/api/tags`

**"Model not found"**:

- Pull the embedding model: `ollama pull nomic-embed-text` or whatever model you have configured for embedding
- For context generation: `ollama pull qwen2.5-coder:1.5b` or whatever model you have configured for context generation.
- Verify models are available: `ollama list`

### Search Issues

**"No results found"**:

- Make sure workspace is indexed: Run `Caffeinated: Index Workspace`
- Check indexing status: Run `Caffeinated: Show Index Status`
- Try different query phrasings or simpler queries
- Check that files aren't excluded by your `excludePatterns`
- Try different search modes: `semantic`, `keyword`, or `hybrid`

**"Results aren't relevant"**:

- Enable context generation for better search quality
- Try hybrid search mode (default) which combines multiple search methods
- Reindex the workspace: `Caffeinated: Reindex Workspace`
- Adjust `rrf.k` value (lower = more weight to top results)

### Performance Issues

**Slow indexing**:

- Disable context generation temporarily for faster initial indexing
- Reduce `embeddingBatchSize` if running out of memory
- Add more patterns to `excludePatterns` (e.g., `**/test/**`, `**/tests/**`)
- Reduce `maxFileSize` to skip very large files
- Check Ollama logs for issues: `ollama logs`

**High memory usage**:

- Reduce `embeddingBatchSize` (default: 10)
- Reduce `contextGenerationBatchSize` (default: 10)
- Lower `ollamaKeepAlive` to unload models sooner
- Close other applications during indexing

**Extension crashes during indexing**:

- Enable debug logging: `"caffeinated.enableDebugLogging": true`
- Check Output panel: View → Output → Select "Caffeinated"
- Reduce batch sizes to prevent overwhelming the API
- Check available disk space (need ~2-5GB for large codebases)

### Custom Endpoint Issues

**Custom endpoint not working**:

- Verify endpoint URL is correct (include protocol: `http://` or `https://`)
- Check if API key is required and correctly configured
- Test endpoint manually with `curl` or Postman
- Enable debug logging to see API requests/responses
- Check endpoint API documentation for correct format

**TabbyML not working**:

- Verify TabbyML is running: Check web UI at configured endpoint
- Check TabbyML version supports embeddings API
- Try without API key first (TabbyML may not require authentication)
- Consult TabbyML documentation for correct API endpoint path

## Contributing

Found a bug or have a feature request? Please open an issue on GitHub. Open a PR and contribute back.

## License

MIT

## Credits

Built with:

- [Ollama](https://ollama.ai) - Local LLM runtime
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - SQLite bindings
- [nomic-embed-text](https://ollama.ai/library/nomic-embed-text) - Default embedding model
- [qwen2.5-coder:1.5b](https://ollama.com/library/qwen2.5-coder:1.5b) - Default context generation model
