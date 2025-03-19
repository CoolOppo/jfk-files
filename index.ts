import { Command } from 'commander';
import { Anthropic } from '@anthropic-ai/sdk';

// Configuration constants
const CONFIG = {
  PATHS: {
    MARKDOWN_OUTPUT: 'out.md'
  },
  CLAUDE: {
    MODEL: 'claude-3-7-sonnet-20250219',
    MAX_TOKENS: 16000,
    TIMEOUT_MS: 300000 // 5 minute timeout
  },
  PRICING: {
    INPUT_PER_MILLION: 3 // $3 per million tokens
  }
};


/**
 * Saves buffer data to a file
 * @param path - Path to save the file
 * @param data - Buffer data to save
 */
async function saveToFile(path: string, data: string | Buffer): Promise<void> {
  await Bun.write(path, data);
  console.log(`File saved to ${path}`);
}

/**
 * Validates base64 encoded string
 * @param base64 - The base64 string to validate
 * @throws Error if base64 is invalid
 */
function validateBase64(base64: string): void {
  if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) {
    throw new Error('Generated invalid base64 data');
  }
}

/**
 * Sends PDF to Claude API for analysis
 * @param pdfBase64 - Base64 encoded PDF data
 * @returns Markdown content from Claude
 */
async function analyzeWithClaude(pdfBase64: string): Promise<string> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }
  
  console.log("Sending to Claude API...");
  const anthropic = new Anthropic({ 
    apiKey,
    timeout: CONFIG.CLAUDE.TIMEOUT_MS 
  });
  
  const response = await anthropic.messages.create({
    model: CONFIG.CLAUDE.MODEL,
    max_tokens: CONFIG.CLAUDE.MAX_TOKENS,
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
            text: 'Convert this page to properly formatted Markdown',
          },
        ],
      },
    ],
  });
  
  console.log('Response received from Claude API');
  
  // Extract text content
  let markdownContent = '';
  if (Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item.type === 'text') {
        markdownContent += item.text;
      }
    }
    return markdownContent;
  }
  
  throw new Error('Unexpected response format from Claude API');
}

/**
 * Main process: reads PDF file and analyzes with Claude
 * @param pdfPath - Path to the PDF file to process
 * @returns Markdown content
 */
async function analyzeFile(pdfPath: string): Promise<string> {
  // Read PDF file
  console.log(`Reading PDF file: ${pdfPath}...`);
  const pdfFile = Bun.file(pdfPath);
  const pdfBuffer = await pdfFile.arrayBuffer();
  
  // Convert PDF to base64
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');
  console.log(`PDF read and converted to base64 (${pdfBase64.length} chars)`);
  
  // Validate base64
  validateBase64(pdfBase64);
  
  // Send to Claude API
  return await analyzeWithClaude(pdfBase64);
}

/**
 * Counts tokens in a PDF file using Anthropic API
 * @param pdfPath - Path to the PDF file
 * @returns Token count and cost information
 */
async function countTokens(pdfPath: string): Promise<{inputTokens: number, cost: number}> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }
  
  console.log(`Reading PDF file: ${pdfPath}...`);
  const pdfFile = Bun.file(pdfPath);
  const pdfBuffer = await pdfFile.arrayBuffer();
  
  // Convert PDF to base64
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');
  console.log(`PDF read and converted to base64 (${pdfBase64.length} chars)`);
  
  // Validate base64
  validateBase64(pdfBase64);
  
  const anthropic = new Anthropic({ 
    apiKey,
    timeout: CONFIG.CLAUDE.TIMEOUT_MS 
  });
  
  console.log("Counting tokens...");
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
          text: 'Please summarize this document.'
        }
      ]
    }]
  });
  
  const inputTokens = response.input_tokens;
  const cost = (inputTokens / 1000000) * CONFIG.PRICING.INPUT_PER_MILLION;
  
  return { inputTokens, cost };
}

/**
 * Main function using Commander to parse arguments
 */
async function main(): Promise<void> {
  const program = new Command();
  
  program
    .name('pdf-analyzer')
    .description('PDF analysis tool using Claude API')
    .version('1.0.0');
  
  program
    .command('convert')
    .description('Convert a PDF to markdown')
    .argument('<pdfPath>', 'path to PDF file')
    .action(async (pdfPath) => {
      try {
        // Check if file exists
        const file = Bun.file(pdfPath);
        const exists = await file.exists();
        if (!exists) {
          console.error(`Error: File not found: ${pdfPath}`);
          process.exit(1);
        }
        
        console.log(`Processing PDF: ${pdfPath}`);
        const markdown = await analyzeFile(pdfPath);
        
        // Save markdown to file
        await saveToFile(CONFIG.PATHS.MARKDOWN_OUTPUT, markdown);
        console.log(`Markdown conversion complete. Output saved to ${CONFIG.PATHS.MARKDOWN_OUTPUT}`);
      } catch (error) {
        console.error('Error:', error);
        process.exit(1);
      }
    });
  
  program
    .command('countTokens')
    .description('Count tokens in a PDF file and calculate cost')
    .argument('<pdfPath>', 'path to PDF file')
    .action(async (pdfPath) => {
      try {
        // Check if file exists
        const file = Bun.file(pdfPath);
        const exists = await file.exists();
        if (!exists) {
          console.error(`Error: File not found: ${pdfPath}`);
          process.exit(1);
        }
        
        const { inputTokens, cost } = await countTokens(pdfPath);
        console.log(`\nToken count: ${inputTokens.toLocaleString()}`);
        console.log(`Estimated cost: $${cost.toFixed(4)} (at $${CONFIG.PRICING.INPUT_PER_MILLION} per million tokens)`);
      } catch (error) {
        console.error('Error:', error);
        process.exit(1);
      }
    });
  
  // For backward compatibility, make convert the default command
  if (Bun.argv.length === 3 && !Bun.argv[2].startsWith('-')) {
    program.parse(['node', 'script.js', 'convert', Bun.argv[2]]);
  } else {
    program.parse();
  }
}

// Execute main function
main();
