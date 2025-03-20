import { Command } from 'commander'
import { Anthropic } from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { setTimeout } from 'timers/promises'

// Configuration constants
const CONFIG = {
  PATHS: {
    MARKDOWN_OUTPUT: 'out.md'
  },
  CLAUDE: {
    MODEL: 'claude-3-7-sonnet-latest',
    MAX_TOKENS: 8192,
    TIMEOUT_MS: 300000 // 5 minute timeout
  },
  PRICING: {
    INPUT_PER_MILLION: 3 // $3 per million tokens
  },
  RATE_LIMITS: {
    REQUESTS_PER_MINUTE: 4000,
    INPUT_TOKENS_PER_MINUTE: 200000,
    OUTPUT_TOKENS_PER_MINUTE: 80000,
    CONCURRENT_REQUESTS: 25 // Conservative default concurrent requests
  }
}

/**
 * Token rate limiter that properly handles both input and output token limits
 */
class TokenRateLimiter {
  private inputTokensUsed = 0;
  private outputTokensUsed = 0;
  private requestsUsed = 0;
  private windowStartTime = Date.now();
  private activeRequests = 0;
  private sampledRatio = 0.5; // Default estimate of output:input token ratio
  private tokenSamples: { inputTokens: number, outputTokens: number }[] = [];
  private pendingQueue: Array<{
    resolve: (value: any) => void
    reject: (error: any) => void
    job: () => Promise<any>
    inputTokenEstimate: number
    retryAttempt: number
  }> = [];
  private retryDelays = [1000, 5000, 15000, 30000]; // Progressive backoff
  private capacityCallbacks: Array<() => void> = [];

  constructor(
    private readonly inputTokenLimit: number,
    private readonly outputTokenLimit: number,
    private readonly requestLimit: number,
    private readonly concurrentLimit: number
  ) {
    // Set up regular window reset checks
    setInterval(() => this.checkAndResetWindow(), 1000)
  }

  /**
   * Update the output:input token ratio based on collected samples
   */
  updateTokenRatio(): void {
    if (this.tokenSamples.length > 0) {
      const totalInput = this.tokenSamples.reduce((sum, sample) => sum + sample.inputTokens, 0)
      const totalOutput = this.tokenSamples.reduce((sum, sample) => sum + sample.outputTokens, 0)
      if (totalInput > 0) {
        this.sampledRatio = totalOutput / totalInput
        console.log(`Updated output:input token ratio to ${this.sampledRatio.toFixed(2)}`)
      }
    }
  }

  /**
   * Add a token usage sample to improve ratio estimation
   */
  addSample(inputTokens: number, outputTokens: number): void {
    this.tokenSamples.push({ inputTokens, outputTokens })
    // Keep last 20 samples for a moving average
    if (this.tokenSamples.length > 20) {
      this.tokenSamples.shift()
    }
    this.updateTokenRatio()
  }

  /**
   * Estimate output tokens based on input tokens and current ratio
   */
  estimateOutputTokens(inputTokens: number): number {
    return Math.ceil(inputTokens * this.sampledRatio)
  }

  /**
   * Check if we need to reset the window
   */
  private checkAndResetWindow(): void {
    const now = Date.now()
    if (now - this.windowStartTime >= 60000) {
      console.log(`Resetting rate limit window. Previous usage: ${this.inputTokensUsed} input, ${this.outputTokensUsed} output, ${this.requestsUsed} requests`)
      this.inputTokensUsed = 0
      this.outputTokensUsed = 0
      this.requestsUsed = 0
      this.windowStartTime = now

      // Process pending queue if we have capacity now
      this.processPendingQueue()
    }
  }

  /**
   * Process any pending requests in the queue
   */
  private processPendingQueue(): void {
    // Process as many pending jobs as we have capacity for
    while (this.pendingQueue.length > 0 && this.hasCapacity()) {
      const nextJob = this.pendingQueue.shift()
      if (nextJob) {
        const { resolve, reject, job, inputTokenEstimate, retryAttempt } = nextJob

        // Execute the job with the original parameters
        this.executeJob(job, inputTokenEstimate, retryAttempt)
          .then(resolve)
          .catch(reject)
      }
    }

    // Notify any capacity waiters
    while (this.capacityCallbacks.length > 0 && this.hasCapacity()) {
      const callback = this.capacityCallbacks.shift()
      if (callback) callback()
    }
  }

  /**
   * Wait for capacity to become available
   */
  private waitForCapacity(): Promise<void> {
    return new Promise(resolve => {
      this.capacityCallbacks.push(resolve)
    })
  }

  /**
   * Check if we have capacity for a request with given token estimates
   */
  private hasCapacity(inputTokens: number = 0, estimatedOutputTokens: number = 0): boolean {
    // Check if we've hit concurrent request limit
    if (this.activeRequests >= this.concurrentLimit) {
      return false
    }

    // Check if we'd exceed any token limits
    if (this.inputTokensUsed + inputTokens > this.inputTokenLimit) {
      return false
    }

    if (this.outputTokensUsed + estimatedOutputTokens > this.outputTokenLimit) {
      return false
    }

    // Check request limit
    if (this.requestsUsed + 1 > this.requestLimit) {
      return false
    }

    return true
  }

  /**
   * Execute a job with token accounting
   */
  private async executeJob<T>(
    job: () => Promise<{ inputTokens: number, outputTokens: number, result: T }>,
    inputTokenEstimate: number,
    retryAttempt: number
  ): Promise<{ inputTokens: number, outputTokens: number, result: T }> {
    // Estimate output tokens based on input estimate and ratio
    const outputTokenEstimate = inputTokenEstimate > 0
      ? this.estimateOutputTokens(inputTokenEstimate)
      : 0

    // Reserve tokens and mark request active
    this.activeRequests++
    this.requestsUsed++

    if (inputTokenEstimate > 0) {
      this.inputTokensUsed += inputTokenEstimate
      this.outputTokensUsed += outputTokenEstimate
    }

    try {
      // Execute the job
      const result = await job()

      // Correct our usage with actual numbers
      if (inputTokenEstimate > 0) {
        // Adjust the counters if estimates were used
        this.inputTokensUsed = this.inputTokensUsed - inputTokenEstimate + result.inputTokens
        this.outputTokensUsed = this.outputTokensUsed - outputTokenEstimate + result.outputTokens
      } else {
        // Just add the actual usage
        this.inputTokensUsed += result.inputTokens
        this.outputTokensUsed += result.outputTokens
      }

      // Add sample to improve future estimates
      this.addSample(result.inputTokens, result.outputTokens)

      return result
    } catch (error) {
      // If estimate was used, remove it since the job failed
      if (inputTokenEstimate > 0) {
        this.inputTokensUsed -= inputTokenEstimate
        this.outputTokensUsed -= outputTokenEstimate
      }

      throw error
    } finally {
      this.activeRequests--

      // Process pending queue since we now have capacity
      this.processPendingQueue()
    }
  }

  /**
   * Schedule a job with appropriate rate limiting
   */
  async schedule<T>(
    job: () => Promise<{ inputTokens: number, outputTokens: number, result: T }>,
    inputTokenEstimate: number = 0,
    retryAttempt: number = 0
  ): Promise<{ inputTokens: number, outputTokens: number, result: T }> {
    // Check if window should be reset
    this.checkAndResetWindow()

    // Estimate output tokens based on input estimate and current ratio
    const outputTokenEstimate = inputTokenEstimate > 0
      ? this.estimateOutputTokens(inputTokenEstimate)
      : 0

    // If we don't have capacity, queue the job
    if (!this.hasCapacity(inputTokenEstimate, outputTokenEstimate)) {
      return new Promise((resolve, reject) => {
        // Add to pending queue
        this.pendingQueue.push({
          resolve,
          reject,
          job,
          inputTokenEstimate,
          retryAttempt
        })

        // Log queue size periodically
        if (this.pendingQueue.length % 10 === 0) {
          console.log(`Rate limit queue size: ${this.pendingQueue.length}`)
        }
      })
    }

    // We have capacity, execute the job
    try {
      return await this.executeJob(job, inputTokenEstimate, retryAttempt)
    } catch (error) {
      // Handle API errors related to rate limiting
      return this.handleRetry(job, inputTokenEstimate, error, retryAttempt)
    }
  }

  /**
   * Handle retries with progressive backoff
   */
  private async handleRetry<T>(
    job: () => Promise<{ inputTokens: number, outputTokens: number, result: T }>,
    inputTokenEstimate: number,
    error: any,
    retryAttempt: number
  ): Promise<{ inputTokens: number, outputTokens: number, result: T }> {
    // Check if error is related to rate limiting
    const isRateLimitError = error?.message && (
      error.message.includes("rate limit") ||
      error.message.includes("429") ||
      error.message.includes("too many requests")
    )

    if (isRateLimitError && retryAttempt < this.retryDelays.length) {
      // Get backoff delay
      const delay = this.retryDelays[retryAttempt]
      console.log(`Rate limit hit. Retrying in ${delay}ms (attempt ${retryAttempt + 1}/${this.retryDelays.length})`)

      // Wait for backoff period
      await setTimeout(delay)

      // Wait for capacity if needed
      if (!this.hasCapacity(inputTokenEstimate, this.estimateOutputTokens(inputTokenEstimate))) {
        await this.waitForCapacity()
      }

      // Retry the job
      return this.schedule(job, inputTokenEstimate, retryAttempt + 1)
    }

    // If not a rate limit error or we've exhausted retries, throw the error
    throw error
  }

  /**
   * Get current usage statistics
   */
  getStats() {
    return {
      inputTokensUsed: this.inputTokensUsed,
      outputTokensUsed: this.outputTokensUsed,
      requestsUsed: this.requestsUsed,
      activeRequests: this.activeRequests,
      queueSize: this.pendingQueue.length,
      outputInputRatio: this.sampledRatio,
      windowTimeRemaining: 60000 - (Date.now() - this.windowStartTime)
    }
  }

  /**
   * Print current stats for debugging
   */
  logStats() {
    const stats = this.getStats()
    console.log(`Rate Limiter Stats:
Input tokens: ${stats.inputTokensUsed}/${this.inputTokenLimit} (${(stats.inputTokensUsed / this.inputTokenLimit * 100).toFixed(1)}%)
Output tokens: ${stats.outputTokensUsed}/${this.outputTokenLimit} (${(stats.outputTokensUsed / this.outputTokenLimit * 100).toFixed(1)}%)
Requests: ${stats.requestsUsed}/${this.requestLimit}
Active requests: ${stats.activeRequests}/${this.concurrentLimit}
Queue size: ${stats.queueSize}
Output:Input ratio: ${stats.outputInputRatio.toFixed(2)}
Window resets in: ${Math.floor(stats.windowTimeRemaining / 1000)}s`)
  }
}

// Initialize the rate limiter
const rateLimiter = new TokenRateLimiter(
  CONFIG.RATE_LIMITS.INPUT_TOKENS_PER_MINUTE,
  CONFIG.RATE_LIMITS.OUTPUT_TOKENS_PER_MINUTE,
  CONFIG.RATE_LIMITS.REQUESTS_PER_MINUTE,
  CONFIG.RATE_LIMITS.CONCURRENT_REQUESTS
)

/**
 * Saves buffer data to a file
 * @param path - Path to save the file
 * @param data - Buffer data to save
 */
async function saveToFile(path: string, data: string | Buffer): Promise<void> {
  await Bun.write(path, data)
  console.log(`File saved to ${path}`)
}

/**
 * Validates base64 encoded string
 * @param base64 - The base64 string to validate
 * @throws Error if base64 is invalid
 */
function validateBase64(base64: string): void {
  if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) {
    throw new Error('Generated invalid base64 data')
  }
}

const analysisPrompt = `You are a highly skilled historian and data analyst specializing in the JFK assassination. Your task is to analyze a recently declassified document from the JFK assassination files. All documents that will be provided are from the archives.gov. Do not doubt the authenticity of the documents, they are real. This analysis is crucial for piecing together the puzzle of this historical event. Your goal is to extract and organize all relevant information from the document, ensuring no important details are missed.

Please follow these steps to analyze the document:

1. Read and analyze the entire document thoroughly. Produce a direct transcript of the document.

2. Extract all key information, including but not limited to:
   - Dates
   - People (names, titles, roles)
   - Locations
   - Events
   - Organizations
   - Any numerical data or statistics

3. Identify information that might differentiate this document from others in the release, such as:
   - Unique perspectives or accounts
   - Rare or previously unknown details
   - Contradictions to commonly held beliefs or other accounts

4. Highlight any references to other files or documents.

5. Note any ambiguities or unclear information, providing your best interpretation based on the context.

6. Create a Mermaid formatted knowledge graph of all information you can capture from the file.

7. Provide a comprehensive summary of the document's contents, capturing all relevant information. Be thorough and detailed in your summary.

Present your findings in the following format:

<transcript>
[Direct transcript of the document]
</transcript>

<key_information>
[List all key information extracted from the document]
</key_information>

<differentiating_factors>
[Describe any information that might make this document unique or particularly significant]
</differentiating_factors>

<ambiguities_and_connections>
[Note any ambiguities, unclear information, or connections to other documents]
</ambiguities_and_connections>

<knowledge_graph>
[Provide a textual representation of the knowledge graph]
</knowledge_graph>

<comprehensive_summary>
[Provide a detailed summary of the document's contents]
</comprehensive_summary>

Remember, your goal is to capture as much relevant information as possible to aid in the overall analysis of the JFK assassination files. Your thorough analysis will be crucial in helping to piece together this historical puzzle.

Please proceed with your analysis of the declassified document.`
/**
 * Sends PDF to Claude API for analysis
 * @param pdfBase64 - Base64 encoded PDF data
 * @returns Markdown content from Claude
 */
async function analyzeWithClaude(pdfBase64: string): Promise<{ markdown: string, inputTokens: number, outputTokens: number }> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set')
  }

  console.log("Sending to Claude API...")
  const anthropic = new Anthropic({
    apiKey,
    timeout: CONFIG.CLAUDE.TIMEOUT_MS
  })

  const response = await anthropic.messages.create({
    model: CONFIG.CLAUDE.MODEL,
    max_tokens: CONFIG.CLAUDE.MAX_TOKENS,
    temperature: 0,
    system: `Your knowledge cutoff is October of 2024.
Today is March 18th, 2025.
Today, the US government declassified many documents in a large document dump about the JFK assassination in an effort to improve transparency.`,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: analysisPrompt,
          },
        ],
      },
    ],
  })

  console.log('Response received from Claude API')

  let markdownContent = ''
  if (Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item.type === 'text') {
        markdownContent += item.text
      }
    }
    const inputTokens = response.usage?.input_tokens || 0
    const outputTokens = response.usage?.output_tokens || 0
    return { markdown: markdownContent, inputTokens, outputTokens }
  }

  throw new Error('Unexpected response format from Claude API')
}

/**
 * Main process: reads PDF file and analyzes with Claude
 * @param pdfPath - Path to the PDF file to process
 * @returns Markdown content
 */
async function analyzeFile(pdfPath: string): Promise<{ markdown: string, inputTokens: number, outputTokens: number }> {
  // Read PDF file
  console.log(`Reading PDF file: ${pdfPath}...`)
  const pdfFile = Bun.file(pdfPath)
  const pdfBuffer = await pdfFile.arrayBuffer()

  // Convert PDF to base64
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')
  console.log(`PDF read and converted to base64 (${pdfBase64.length} chars)`)

  // Validate base64
  validateBase64(pdfBase64)

  // Send to Claude API
  return await analyzeWithClaude(pdfBase64)
}

/**
 * Schedule a PDF analysis job with the rate limiter
 */
async function scheduleAnalysis(job: () => Promise<{ markdown: string, inputTokens: number, outputTokens: number }>, inputTokenEstimate: number = 0): Promise<{ result: string, inputTokens: number, outputTokens: number }> {
  try {
    const result = await rateLimiter.schedule(
      async () => {
        const response = await job()
        return {
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          result: response.markdown
        }
      },
      inputTokenEstimate
    )

    return result
  } catch (error) {
    console.error('Error during analysis:', error)
    throw error
  }
}

/**
 * Sample a subset of PDFs to estimate token usage
 */
async function sampleTokenUsage(pdfFiles: string[], sampleSize: number = Math.min(10, pdfFiles.length)): Promise<{
  avgInputTokens: number,
  avgOutputTokens: number,
  ratio: number
}> {
  // Take either sampleSize or all files, whichever is smaller
  const samplesToTake = Math.min(sampleSize, pdfFiles.length)
  if (samplesToTake === 0) return { avgInputTokens: 0, avgOutputTokens: 0, ratio: 0.5 }

  console.log(`Sampling ${samplesToTake} files to estimate token usage...`)

  // Use a stratified sampling approach - get files of different sizes
  // Sort files by size to get a distribution
  const filesWithSize = await Promise.all(
    pdfFiles.map(async file => {
      const stats = await fs.promises.stat(file)
      return { file, size: stats.size }
    })
  )

  // Sort by size
  filesWithSize.sort((a, b) => a.size - b.size)

  // Select files from different size percentiles
  const sampleFiles: string[] = []
  if (samplesToTake === 1) {
    // If only one sample, take the median
    const medianIndex = Math.floor(filesWithSize.length / 2)
    if (filesWithSize[medianIndex]) {
      sampleFiles.push(filesWithSize[medianIndex].file)
    }
  } else {
    // Otherwise distribute samples across the range
    for (let i = 0; i < samplesToTake; i++) {
      const index = Math.floor(i * (filesWithSize.length - 1) / (samplesToTake - 1))
      if (filesWithSize[index]) {
        sampleFiles.push(filesWithSize[index].file)
      }
    }
  }

  console.log(`Selected sample files: ${sampleFiles.map(f => path.basename(f)).join(', ')}`)

  // Count tokens for each sample file
  const tokenCounts = await Promise.all(
    sampleFiles.map(async file => {
      console.log(`Sampling token count for: ${path.basename(file)}`)
      const { inputTokens, cost } = await countTokens(file)

      // Initial estimate is only for the first batch calculation
      // We'll get real output tokens when we process files
      const estimatedOutputTokens = Math.round(inputTokens * 0.5) // Initial guess at ratio

      return { file, inputTokens, estimatedOutputTokens }
    })
  )

  // Calculate average token counts
  const totalInputTokens = tokenCounts.reduce((sum, count) => sum + count.inputTokens, 0)
  const totalEstimatedOutputTokens = tokenCounts.reduce((sum, count) => sum + count.estimatedOutputTokens, 0)

  const avgInputTokens = Math.round(totalInputTokens / tokenCounts.length)
  const avgOutputTokens = Math.round(totalEstimatedOutputTokens / tokenCounts.length)

  const ratio = avgOutputTokens / avgInputTokens

  console.log(`Token usage estimates:
Average input tokens per file: ${avgInputTokens}
Estimated average output tokens per file: ${avgOutputTokens}
Output:Input ratio: ${ratio.toFixed(2)}`)

  return { avgInputTokens, avgOutputTokens, ratio }
}

function getPdfFilesInDirectory(directoryPath: string): string[] {
  const files = fs.readdirSync(directoryPath)
  return files
    .filter(file => file.toLowerCase().endsWith('.pdf'))
    .map(file => path.join(directoryPath, file))
}

/**
 * Ensure the analysis directory exists
 * @param baseDir - Base directory path
 * @returns Path to the analysis directory
 */
function ensureAnalysisDir(baseDir: string): string {
  const analysisDir = path.join(baseDir, 'analysis')
  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true })
  }
  return analysisDir
}

/**
 * Ask user for confirmation
 * @param question - Question to ask
 * @returns Promise resolving to boolean
 */
async function askForConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}

/**
 * Counts tokens in a PDF file using Anthropic API
 * @param pdfPath - Path to the PDF file
 * @returns Token count and cost information
 */
async function countTokens(pdfPath: string): Promise<{ inputTokens: number, cost: number }> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set')
  }

  console.log(`Reading PDF file: ${pdfPath}...`)
  const pdfFile = Bun.file(pdfPath)
  const pdfBuffer = await pdfFile.arrayBuffer()

  // Convert PDF to base64
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')
  console.log(`PDF read and converted to base64 (${pdfBase64.length} chars)`)

  // Validate base64
  validateBase64(pdfBase64)

  const anthropic = new Anthropic({
    apiKey,
    timeout: CONFIG.CLAUDE.TIMEOUT_MS
  })

  console.log("Counting tokens...")

  const response = await anthropic.messages.countTokens({
    model: CONFIG.CLAUDE.MODEL,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64
          }
        },
        {
          type: 'text',
          text: analysisPrompt
        }
      ]
    }]
  })

  const inputTokens = response.input_tokens
  const cost = (inputTokens / 1000000) * CONFIG.PRICING.INPUT_PER_MILLION

  return { inputTokens, cost }
}

// Process batch of files in parallel, respecting rate limits
async function processBatch(
  pdfFiles: string[],
  analysisDir: string,
  batchSize: number,
  inputTokenEstimate: number,
  onProgress: (completed: number, total: number) => void
): Promise<Array<{ filePath: string, success: boolean, inputTokens?: number, outputTokens?: number, error?: any }>> {
  const results: Array<{ filePath: string, success: boolean, inputTokens?: number, outputTokens?: number, error?: any }> = []
  let completed = 0
  const total = pdfFiles.length

  // Process in batches to control memory usage
  for (let i = 0; i < pdfFiles.length; i += batchSize) {
    const batch = pdfFiles.slice(i, i + batchSize).filter(Boolean)

    // Process this batch in parallel
    const batchPromises = batch.map(async (filePath) => {
      const fileName = path.basename(filePath, '.pdf')
      const outputPath = path.join(analysisDir, `${fileName}.md`)

      try {
        console.log(`Processing: ${fileName}.pdf...`)
        const { result: markdown, inputTokens, outputTokens } = await scheduleAnalysis(
          () => analyzeFile(filePath),
          inputTokenEstimate
        )

        await saveToFile(outputPath, markdown)
        console.log(`Finished processing: ${fileName}.pdf (${inputTokens} input, ${outputTokens} output tokens, ratio: ${(outputTokens / inputTokens).toFixed(2)})`)

        completed++
        onProgress(completed, total)

        return { filePath, success: true, inputTokens, outputTokens }
      } catch (error) {
        console.error(`Error processing ${fileName}.pdf:`, error)
        completed++
        onProgress(completed, total)

        return { filePath, success: false, error }
      }
    })

    // Wait for the current batch to complete before starting the next batch
    const batchResults = await Promise.all(batchPromises)
    results.push(...batchResults)
  }

  return results
}

/**
 * Main function using Commander to parse arguments
 */
async function main(): Promise<void> {
  const program = new Command()

  program
    .name('pdf-analyzer')
    .description('PDF analysis tool using Claude API')
    .version('1.0.0')
    .option('-b, --batch-size <number>', 'Number of files to process in parallel', (val) => parseInt(val, 10), 5)

  program
    .command('convert')
    .description('Convert a PDF to markdown')
    .argument('<pdfPath>', 'path to PDF file')
    .action(async (pdfPath) => {
      try {
        // Check if file exists
        const file = Bun.file(pdfPath)
        const exists = await file.exists()
        if (!exists) {
          console.error(`Error: File not found: ${pdfPath}`)
          process.exit(1)
        }

        console.log(`Processing PDF: ${pdfPath}`)
        const { result: markdown } = await scheduleAnalysis(() => analyzeFile(pdfPath))

        // Save markdown to file
        await saveToFile(CONFIG.PATHS.MARKDOWN_OUTPUT, markdown)
        console.log(`Markdown conversion complete. Output saved to ${CONFIG.PATHS.MARKDOWN_OUTPUT}`)
      } catch (error) {
        console.error('Error:', error)
        process.exit(1)
      }
    })

  program
    .command('countTokens')
    .description('Count tokens in a PDF file and calculate cost')
    .argument('<pdfPath>', 'path to PDF file')
    .action(async (pdfPath) => {
      try {
        // Check if file exists
        const file = Bun.file(pdfPath)
        const exists = await file.exists()
        if (!exists) {
          console.error(`Error: File not found: ${pdfPath}`)
          process.exit(1)
        }

        const { inputTokens, cost } = await countTokens(pdfPath)
        console.log(`\nToken count: ${inputTokens.toLocaleString()}`)
        console.log(`Estimated cost: $${cost.toFixed(4)} (at $${CONFIG.PRICING.INPUT_PER_MILLION} per million tokens)`)
      } catch (error) {
        console.error('Error:', error)
        process.exit(1)
      }
    })

  program
    .command('processFolder')
    .description('Process all PDF files in a folder')
    .argument('<folderPath>', 'path to folder containing PDF files')
    .option('-s, --sample-size <number>', 'Number of files to sample for token estimation', (val) => parseInt(val, 10))
    .option('-b, --batch-size <number>', 'Number of files to process in parallel', (val) => parseInt(val, 10), 5)
    .option('-y, --yes', 'Skip confirmation and proceed with processing')
    .action(async (folderPath: string, options: { sampleSize?: number, batchSize?: number, yes?: boolean }) => {
      try {
        if (!fs.existsSync(folderPath)) {
          console.error(`Error: Folder not found: ${folderPath}`)
          process.exit(1)
        }
        const analysisDir = ensureAnalysisDir(folderPath)
        const allPdfFiles = getPdfFilesInDirectory(folderPath)
        const pdfFiles = allPdfFiles.filter((filePath) => {
          const fileName = path.basename(filePath, '.pdf')
          const outputPath = path.join(analysisDir, `${fileName}.md`)
          return !fs.existsSync(outputPath)
        })
        const numSkipped = allPdfFiles.length - pdfFiles.length
        console.log(`Found ${allPdfFiles.length} PDF files in ${folderPath}. Skipping ${numSkipped} already processed files.`)
        if (pdfFiles.length === 0) {
          console.log(`All files have already been processed. Nothing to do.`)
          process.exit(0)
        }

        // Determine batch size for parallel processing (default 5)
        const batchSize = options.batchSize || 5
        console.log(`Using batch size of ${batchSize} for parallel processing`)

        // Determine sample size - default to 10 or user-specified
        const sampleSize = options.sampleSize ? Number(options.sampleSize) : Math.min(10, pdfFiles.length)
        console.log(`Using sample size of ${sampleSize} files for token estimation`)

        // Sample token usage to adjust our initial ratio
        const { avgInputTokens, ratio } = await sampleTokenUsage(pdfFiles, sampleSize)

        // Update our rate limiter with the sampled ratio
        rateLimiter.addSample(avgInputTokens, Math.round(avgInputTokens * ratio))

        // Calculate total estimated cost
        const totalTokens = avgInputTokens * pdfFiles.length
        const estimatedCost = (totalTokens / 1000000) * CONFIG.PRICING.INPUT_PER_MILLION

        console.log(`\nEstimated token usage for ${pdfFiles.length} files:`)
        console.log(`- Input tokens per file (avg): ${avgInputTokens.toLocaleString()}`)
        console.log(`- Total input tokens: ${totalTokens.toLocaleString()}`)
        console.log(`- Estimated cost: $${estimatedCost.toFixed(2)} (at $${CONFIG.PRICING.INPUT_PER_MILLION} per million tokens)`)

        // Confirm with user unless --yes flag is provided
        if (!options.yes) {
          const proceed = await askForConfirmation('\nDo you want to proceed with processing these files? (y/n): ')
          if (!proceed) {
            console.log('Operation cancelled by user.')
            process.exit(0)
          }
        }

        // Track progress stats
        let completedFiles = 0
        let totalFiles = pdfFiles.length
        let startTime = Date.now()

        // Set up interval to display stats
        const statsInterval = setInterval(() => {
          rateLimiter.logStats()

          if (completedFiles > 0) {
            const elapsedSecs = (Date.now() - startTime) / 1000
            const filesPerHour = completedFiles / elapsedSecs * 3600
            const estimatedTimeRemaining = (totalFiles - completedFiles) / filesPerHour * 60 // minutes

            console.log(`Progress: ${completedFiles}/${totalFiles} files (${(completedFiles / totalFiles * 100).toFixed(1)}%)`)
            console.log(`Rate: ${filesPerHour.toFixed(1)} files/hour`)
            if (!isNaN(estimatedTimeRemaining) && isFinite(estimatedTimeRemaining)) {
              console.log(`Est. time remaining: ${estimatedTimeRemaining.toFixed(1)} minutes`)
            } else {
              console.log(`Est. time remaining: calculating...`)
            }
          }
        }, 60000) // Show stats every minute

        // Process files in parallel batches
        console.log(`\nProcessing files in parallel batches of ${batchSize}...`)

        const onProgressUpdate = (completed: number, total: number) => {
          completedFiles = completed
        }

        const results = await processBatch(
          pdfFiles,
          analysisDir,
          batchSize,
          avgInputTokens,
          onProgressUpdate
        )

        // Stop the stats interval
        clearInterval(statsInterval)

        // Final stats
        const successCount = results.filter(result => result.success).length
        const failCount = results.length - successCount
        console.log("\n=== Analysis Complete ===")
        console.log(`Successfully processed: ${successCount}/${pdfFiles.length} files`)
        console.log(`Failed: ${failCount} files`)
        console.log(`Results saved to: ${analysisDir}`)

      } catch (error) {
        console.error('Error:', error)
        process.exit(1)
      }
    })

  // Fix for running with Bun directly
  // When running with Bun, we need to parse all arguments including the script path
  // Get all command line arguments except for "bun" and script path
  const args = process.argv.slice(2)

  // Check if any arguments are provided
  if (args.length === 0) {
    program.help()
  } else if (args.length === 1 && args[0] && !args[0].startsWith('-')) {
    // For backward compatibility, if only one argument and not a flag
    // Treat it as a convert command
    program.parse(['node', 'script.js', 'convert', args[0] || ''])
  } else {
    // Otherwise parse normally
    program.parse(process.argv)
  }
}

// Execute main function
main()
