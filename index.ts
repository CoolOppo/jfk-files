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
    MAX_TOKENS: 16000,
    TIMEOUT_MS: 300000 // 5 minute timeout
  },
  PRICING: {
    INPUT_PER_MILLION: 0.8 // $0.80 per million tokens
  },
  RATE_LIMITS: {
    REQUESTS_PER_MINUTE: 4000,
    INPUT_TOKENS_PER_MINUTE: 400000,
    OUTPUT_TOKENS_PER_MINUTE: 80000,
    CONCURRENT_REQUESTS: 10 // Conservative default concurrent requests
  }
}

/**
 * Rate limiter to manage API request rate
 */
class RateLimiter {
  private requestCount: number = 0
  private inputTokenCount: number = 0
  private outputTokenCount: number = 0
  private lastResetTime: number = Date.now()
  private queue: Array<() => Promise<any>> = []
  private runningTasks: number = 0
  private maxConcurrent: number

  constructor(maxConcurrent: number = CONFIG.RATE_LIMITS.CONCURRENT_REQUESTS) {
    this.maxConcurrent = maxConcurrent
    // Reset counters every minute
    setInterval(() => this.resetCounters(), 60000)
  }

  private resetCounters(): void {
    this.requestCount = 0
    this.inputTokenCount = 0
    this.outputTokenCount = 0
    this.lastResetTime = Date.now()
    console.log('Rate limit counters reset')
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0 || this.runningTasks >= this.maxConcurrent) {
      return
    }

    const task = this.queue.shift()
    if (!task) return

    this.runningTasks++
    try {
      await task()
    } catch (error) {
      console.error('Error in queued task:', error)
    } finally {
      this.runningTasks--
      // Process next task
      this.processQueue()
    }
  }

  public async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task()
          resolve(result)
        } catch (error) {
          reject(error)
        }
      })

      // Start processing the queue
      this.processQueue()
    })
  }

  public async trackRequest(inputTokens: number = 0, outputTokens: number = 0): Promise<void> {
    // Check if we're approaching rate limits
    if (
      this.requestCount >= CONFIG.RATE_LIMITS.REQUESTS_PER_MINUTE ||
      this.inputTokenCount + inputTokens >= CONFIG.RATE_LIMITS.INPUT_TOKENS_PER_MINUTE ||
      this.outputTokenCount + outputTokens >= CONFIG.RATE_LIMITS.OUTPUT_TOKENS_PER_MINUTE
    ) {
      // Wait until the next minute reset
      const timeUntilReset = 60000 - (Date.now() - this.lastResetTime)
      if (timeUntilReset > 0) {
        console.log(`Rate limit approaching, waiting ${Math.ceil(timeUntilReset / 1000)} seconds...`)
        await setTimeout(timeUntilReset)
      }
    }

    // Track this request
    this.requestCount++
    this.inputTokenCount += inputTokens
    this.outputTokenCount += outputTokens
  }

  // Return current usage as percentages of limits
  public getUsagePercentages(): { requests: number, inputTokens: number, outputTokens: number } {
    return {
      requests: (this.requestCount / CONFIG.RATE_LIMITS.REQUESTS_PER_MINUTE) * 100,
      inputTokens: (this.inputTokenCount / CONFIG.RATE_LIMITS.INPUT_TOKENS_PER_MINUTE) * 100,
      outputTokens: (this.outputTokenCount / CONFIG.RATE_LIMITS.OUTPUT_TOKENS_PER_MINUTE) * 100
    }
  }
}

// Create a single instance of the rate limiter
const rateLimiter = new RateLimiter()


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

1. Read and analyze the entire document thoroughly.

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
async function analyzeWithClaude(pdfBase64: string): Promise<string> {
  return rateLimiter.enqueue(async () => {
    const apiKey = Bun.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set')
    }

    console.log("Sending to Claude API...")
    const anthropic = new Anthropic({
      apiKey,
      timeout: CONFIG.CLAUDE.TIMEOUT_MS
    })

    // Track request before sending (we don't know token counts yet)
    await rateLimiter.trackRequest()

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

    // Track token usage
    const inputTokens = response.usage?.input_tokens || 0
    const outputTokens = response.usage?.output_tokens || 0
    await rateLimiter.trackRequest(inputTokens, outputTokens)

    // Extract text content
    let markdownContent = ''
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item.type === 'text') {
          markdownContent += item.text
        }
      }
      return markdownContent
    }

    throw new Error('Unexpected response format from Claude API')
  })
}

/**
 * Main process: reads PDF file and analyzes with Claude
 * @param pdfPath - Path to the PDF file to process
 * @returns Markdown content
 */
async function analyzeFile(pdfPath: string): Promise<string> {
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
 * Get all PDF files in a directory
 * @param directoryPath - Path to the directory
 * @returns Array of PDF file paths
 */
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
  return rateLimiter.enqueue(async () => {
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

    // Track this API request (no output tokens for count endpoint)
    await rateLimiter.trackRequest()

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
  })
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
    .option('-b, --batch-size <number>', 'Number of concurrent files to process', (val) => parseInt(val, 10))

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
        const markdown = await analyzeFile(pdfPath)

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
    .action(async (folderPath) => {
      try {
        // Check if folder exists
        if (!fs.existsSync(folderPath)) {
          console.error(`Error: Folder not found: ${folderPath}`)
          process.exit(1)
        }

        // Get all PDF files in the folder
        const pdfFiles = getPdfFilesInDirectory(folderPath)

        if (pdfFiles.length === 0) {
          console.error(`Error: No PDF files found in ${folderPath}`)
          process.exit(1)
        }

        console.log(`Found ${pdfFiles.length} PDF files in ${folderPath}`)

        // First count tokens and calculate cost for all files
        console.log("Counting tokens for all files (this may take a moment)...")

        const countPromises = pdfFiles.map(async (filePath) => {
          try {
            const { inputTokens, cost } = await countTokens(filePath)
            return { filePath, inputTokens, cost }
          } catch (error) {
            console.error(`Error counting tokens for ${filePath}:`, error)
            return { filePath, inputTokens: 0, cost: 0, error }
          }
        })

        const tokenResults = await Promise.all(countPromises)

        // Calculate totals
        const validResults = tokenResults.filter(result => !result.error)
        const totalTokens = validResults.reduce((sum, result) => sum + result.inputTokens, 0)
        const totalCost = validResults.reduce((sum, result) => sum + result.cost, 0)

        console.log("\n=== Token Count Summary ===")
        validResults.forEach(result => {
          const fileName = path.basename(result.filePath)
          console.log(`${fileName}: ${result.inputTokens.toLocaleString()} tokens ($${result.cost.toFixed(4)})`)
        })

        console.log("\n=== Total ===")
        console.log(`Total tokens: ${totalTokens.toLocaleString()}`)
        console.log(`Total estimated cost: $${totalCost.toFixed(2)}`)

        if (tokenResults.length !== validResults.length) {
          console.log(`\nWarning: ${tokenResults.length - validResults.length} files could not be analyzed`)
        }

        // Ask for confirmation to proceed
        const shouldContinue = await askForConfirmation("\nDo you want to proceed with analyzing all files? (y/n): ")

        if (!shouldContinue) {
          console.log("Operation cancelled by user.")
          process.exit(0)
        }

        // Create the analysis subfolder
        const analysisDir = ensureAnalysisDir(folderPath)
        console.log(`\nAnalysis will be saved to: ${analysisDir}`)

        // Process files with rate limiting
        console.log("Processing all files with rate limiting...\n")

        // Add a batch size option
        program.option('-b, --batch-size <number>', 'Number of concurrent files to process', (val) => parseInt(val, 10))
        const options = program.opts()
        const batchSize = options.batchSize || CONFIG.RATE_LIMITS.CONCURRENT_REQUESTS

        console.log(`Using batch size of ${batchSize} concurrent requests`)

        // Process files with controlled concurrency
        const analysisResults = []
        for (let i = 0; i < validResults.length; i += batchSize) {
          const batch = validResults.slice(i, i + batchSize)
          console.log(`Processing batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(validResults.length/batchSize)}...`)

          const batchPromises = batch.map(async ({ filePath }) => {
            try {
              const fileName = path.basename(filePath, '.pdf')
              const outputPath = path.join(analysisDir, `${fileName}.md`)

              console.log(`Processing: ${fileName}.pdf...`)
              const markdown = await analyzeFile(filePath)
              await saveToFile(outputPath, markdown)

              const result = { filePath, success: true }
              analysisResults.push(result)
              return result
            } catch (error) {
              console.error(`Error processing ${filePath}:`, error)
              const result = { filePath, success: false, error }
              analysisResults.push(result)
              return result
            }
          })

          // Wait for current batch to complete before starting next batch
          await Promise.all(batchPromises)

          // Display rate limit usage after each batch
          const usage = rateLimiter.getUsagePercentages()
          console.log(`\nCurrent rate limit usage:`)
          console.log(`- Requests: ${usage.requests.toFixed(1)}%`)
          console.log(`- Input tokens: ${usage.inputTokens.toFixed(1)}%`)
          console.log(`- Output tokens: ${usage.outputTokens.toFixed(1)}%\n`)
        }

        const successCount = analysisResults.filter(result => result.success).length

        console.log("\n=== Analysis Complete ===")
        console.log(`Successfully processed: ${successCount}/${validResults.length} files`)
        console.log(`Results saved to: ${analysisDir}`)

      } catch (error) {
        console.error('Error:', error)
        process.exit(1)
      }
    })

  // For backward compatibility, make convert the default command
  if (Bun.argv.length === 3 && !Bun.argv[2].startsWith('-')) {
    program.parse(['node', 'script.js', 'convert', Bun.argv[2]])
  } else {
    program.parse()
  }
}

// Execute main function
main()
