import { Command } from 'commander'
import { Anthropic } from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { setTimeout } from 'timers/promises'
import Bottleneck from 'bottleneck'

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
    INPUT_PER_MILLION: 3 // $0.80 per million tokens
  },
  RATE_LIMITS: {
    REQUESTS_PER_MINUTE: 4000,
    INPUT_TOKENS_PER_MINUTE: 200000,
    OUTPUT_TOKENS_PER_MINUTE: 80000,
    CONCURRENT_REQUESTS: 25 // Conservative default concurrent requests
  }
}

let analysisLimiter = new Bottleneck({
  maxConcurrent: CONFIG.RATE_LIMITS.CONCURRENT_REQUESTS,
  reservoir: Infinity
})



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
    return markdownContent
  }

  throw new Error('Unexpected response format from Claude API')
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
        const markdown = await analysisLimiter.schedule(() => analyzeFile(pdfPath))

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
        if (!fs.existsSync(folderPath)) {
          console.error(`Error: Folder not found: ${folderPath}`)
          process.exit(1)
        }
        const pdfFiles = getPdfFilesInDirectory(folderPath)
        if (pdfFiles.length === 0) {
          console.error(`Error: No PDF files found in ${folderPath}`)
          process.exit(1)
        }
        console.log(`Found ${pdfFiles.length} PDF files in ${folderPath}`)

        // Sample 20 random documents for token usage estimation
        const sampleCount = Math.min(20, pdfFiles.length)
        const shuffled = pdfFiles.sort(() => 0.5 - Math.random())
        const sampleFiles = shuffled.slice(0, sampleCount)

        console.log("Sampling 20 documents for token usage estimation...")
        const sampleResults = await Promise.all(sampleFiles.map(async (filePath) => {
          try {
            const { inputTokens } = await countTokens(filePath)
            return inputTokens
          } catch (error) {
            console.error(`Error counting tokens for ${filePath}:`, error)
            return 0
          }
        }))

        const validSamples = sampleResults.filter(t => t > 0)
        if (validSamples.length === 0) {
          console.error("Error: Unable to estimate token usage from samples.")
          process.exit(1)
        }
        const avgInput = validSamples.reduce((sum, t) => sum + t, 0) / validSamples.length
        const avgOutput = avgInput * 0.5 // assume output tokens are half of input tokens

        const tasksPerMinuteInput = Math.floor((0.8 * CONFIG.RATE_LIMITS.INPUT_TOKENS_PER_MINUTE) / avgInput)
        const tasksPerMinuteOutput = Math.floor((0.8 * CONFIG.RATE_LIMITS.OUTPUT_TOKENS_PER_MINUTE) / avgOutput)
        let tasksPerMinuteAllowed = Math.min(tasksPerMinuteInput, tasksPerMinuteOutput)
        tasksPerMinuteAllowed = Math.max(tasksPerMinuteAllowed, 1)

        analysisLimiter.updateSettings({
          reservoir: tasksPerMinuteAllowed,
          reservoirRefreshAmount: tasksPerMinuteAllowed,
          reservoirRefreshInterval: 60000,
          maxConcurrent: Math.min(CONFIG.RATE_LIMITS.CONCURRENT_REQUESTS, tasksPerMinuteAllowed)
        })

        console.log(`Estimated average input tokens: ${avgInput.toFixed(2)}`)
        console.log(`Configured analysis throughput: ${tasksPerMinuteAllowed} tasks per minute with max concurrent ${Math.min(CONFIG.RATE_LIMITS.CONCURRENT_REQUESTS, tasksPerMinuteAllowed)}`)

        const analysisDir = ensureAnalysisDir(folderPath)
        console.log(`\nAnalysis will be saved to: ${analysisDir}\n`)

        // Process all files concurrently using the analysisLimiter
        const analysisPromises = pdfFiles.map((filePath) => {
          return analysisLimiter.schedule(async () => {
            try {
              const fileName = path.basename(filePath, '.pdf')
              const outputPath = path.join(analysisDir, `${fileName}.md`)
              if (fs.existsSync(outputPath)) {
                console.log(`Skipping: ${fileName}.md already exists.`)
                return { filePath, success: true, skipped: true }
              }
              console.log(`Processing: ${fileName}.pdf...`)
              const markdown = await analyzeFile(filePath)
              await saveToFile(outputPath, markdown)
              console.log(`Finished processing: ${fileName}.pdf`)
              return { filePath, success: true }
            } catch (error) {
              console.error(`Error processing ${filePath}:`, error)
              return { filePath, success: false, error }
            }
          })
        })

        const analysisResults = await Promise.all(analysisPromises)
        const successCount = analysisResults.filter(result => result.success).length
        console.log("\n=== Analysis Complete ===")
        console.log(`Successfully processed: ${successCount}/${pdfFiles.length} files`)
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
