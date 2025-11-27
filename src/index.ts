import { mkdir, readFile, stat, writeFile, cp } from "fs/promises";
import { spawnSync } from "child_process";
import path from "path";

type CurrencyValue = number | null | undefined;

interface TemplateData {
  document: {
    title: string;
    statementNumber: string;
    accountNumber: string;
    statementPeriod: string;
    statementDate: string;
    qrCode: string;
    qrAltText: string;
    pageCount?: string;
    singlePageBodyClass?: string;
  };
  company: {
    name: string;
    tagline: string;
    contactEmail: string;
    contactPhone: string;
  };
  recipient: {
    addressLines: string[];
  };
  balances: {
    opening: number;
    withdrawals: number;
    deposits: number;
    closingLabel: string;
    closing: number;
  };
  transactions: Array<{
    postedDate: string;
    transactionDate: string;
    cardId: string;
    details: string;
    withdrawals?: CurrencyValue;
    deposits?: CurrencyValue;
    balance: number;
  }>;
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function copyDirectoryIfExists(
  source: string,
  destination: string
): Promise<void> {
  try {
    await cp(source, destination, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

interface CommandCandidate {
  command: string;
  args: string[];
  description: string;
}

function resolveCommandCandidates(
  inputPath: string,
  outputPath: string
): CommandCandidate[] {
  const baseArgs = [inputPath, outputPath];

  const envCandidate = process.env.WEASYPRINT_BIN
    ? (() => {
        const parts = process.env.WEASYPRINT_BIN.trim().split(/\s+/);
        if (!parts.length) {
          return undefined;
        }
        return {
          command: parts[0],
          args: [...parts.slice(1), ...baseArgs],
          description: `WEASYPRINT_BIN (${process.env.WEASYPRINT_BIN})`,
        } satisfies CommandCandidate;
      })()
    : undefined;

  const candidates: CommandCandidate[] = [
    envCandidate,
    { command: "weasyprint", args: baseArgs, description: "weasyprint" },
    {
      command: "py",
      args: ["-m", "weasyprint", ...baseArgs],
      description: "py -m weasyprint",
    },
    {
      command: "python",
      args: ["-m", "weasyprint", ...baseArgs],
      description: "python -m weasyprint",
    },
  ].filter((candidate): candidate is CommandCandidate => Boolean(candidate));

  return candidates;
}

function runWeasyPrint(inputPath: string, outputPath: string): void {
  const candidates = resolveCommandCandidates(inputPath, outputPath);
  const attempts: Array<{
    description: string;
    error: Error | null;
    status: number | null;
  }> = [];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      stdio: "inherit",
    });

    if (!result.error && result.status === 0) {
      return;
    }

    attempts.push({
      description: candidate.description,
      error: result.error ?? null,
      status: result.status ?? null,
    });

    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      break;
    }
  }

  const details = attempts
    .map((entry) => {
      const parts = [` - ${entry.description}`];
      if (entry.error) {
        parts.push(`error=${entry.error.message}`);
      }
      if (entry.status !== null) {
        parts.push(`status=${entry.status}`);
      }
      return parts.join(" ");
    })
    .join("\n");

  throw new Error(
    `Unable to run WeasyPrint. Tried the following commands:\n${details}`
  );
}

function loadJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function flattenObject(
  value: unknown,
  prefix = "",
  tokenMap: Record<string, string> = {}
): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return tokenMap;
  }

  for (const [key, entry] of Object.entries(value)) {
    const token = prefix ? `${prefix}.${key}` : key;
    if (entry === null || entry === undefined) {
      continue;
    }

    if (typeof entry === "object" && !Array.isArray(entry)) {
      flattenObject(entry, token, tokenMap);
      continue;
    }

    if (!Array.isArray(entry)) {
      tokenMap[token] = String(entry);
    }
  }

  return tokenMap;
}

/**
 * Configuration for variable interchanges in template.html
 * Maps old variable format to new variable format
 * Easy to customize for future needs
 */
const VARIABLE_INTERCHANGE_MAP: Record<string, string> = {
  "{{document.title}}": "{{ statement.title }}",
  "{{document.singlePageBodyClass}}": "{{ document.single_page_body_class }}",
  "{{company.name}}": "{{ company.name }}",
  "{{company.tagline}}": "{{ company.tagline }}",
  "{{company.contactEmail}}": "{{ company.contact_email }}",
  "{{company.contactPhone}}": "{{ company.contact_phone }}",
  "{{document.statementNumber}}": "{{ statement.statement_id[:6] }}",
  "{{document.accountNumber}}":
    "**** **** **** {{ statement.account_number_last_four -}}",
  "{{document.statementPeriod}}":
    "{{ statement.statement_period_start.strftime('%b %d').replace(' 0', ' ') }} - {{ statement.statement_period_end.strftime('%b %d, %Y').replace(' 0', ' ') }}",
  "{{document.statementDate}}":
    "{{ statement.statement_date.strftime('%b %d, %Y').replace(' 0', ' ') }}",
  "{{document.pageCount}}": "{{ statement.page_count }}",
  "{{document.qrCode}}":
    "data:image/png;base64,{{ statement.statement_id_qr_base64 }}",
  "{{document.qrAltText}}": "{{ statement.statement_id }}",
  "{{recipient.addressHtml}}":
    "<p>{{ statement.account_holder_name }}</p>\n              <p>{{ statement.account_holder_address.line1 }}</p>\n              {% if statement.account_holder_address.line2 %}\n              <p>{{ statement.account_holder_address.line2 }}</p>\n              {% endif %}\n              <p>\n                {{ statement.account_holder_address.city }}, {{\n                statement.account_holder_address.state }} {{\n                statement.account_holder_address.postal_code }}\n              </p>",
  "{{balances.opening}}": "${{ statement.transaction_data.opening_balance }}",
  "{{balances.withdrawals}}":
    "- ${{ statement.transaction_data.debits_total }}",
  "{{balances.deposits}}": "+ ${{ statement.transaction_data.credits_total }}",
  "{{balances.closingLabel}}":
    "Closing Balance on {{\n                statement.statement_period_end.strftime('%m-%d-%Y') }}",
  "{{balances.closing}}": "${{ statement.transaction_data.closing_balance }}",
  "{{transactions.rows}}":
    '  <tr>\n              <td>\n                {{ statement.statement_period_start.strftime(\'%m-%d-%Y\') }}\n              </td>\n              <td>Opening Balance</td>\n              <td></td>\n              <td class="numeric"></td>\n              <td class="numeric"></td>\n              <td class="numeric">\n                ${{ statement.transaction_data.opening_balance }}\n              </td>\n            </tr>\n            {% for txn in statement.transaction_data.transactions %}\n            <tr>\n              <td>{{ txn.posted_datetime.strftime(\'%m-%d-%Y\') }}</td>\n              <td>{{ txn.check_number or \'\' }}</td>\n              <td>{{ txn.transaction_description }}</td>\n              <td class="numeric">{{ txn.withdrawal_amount }}</td>\n              <td class="numeric">{{ txn.deposit_amount }}</td>\n              <td class="numeric">${{ txn.account_balance }}</td>\n            </tr>\n            {% endfor %}',
};

/**
 * Interchanges variables in the template according to VARIABLE_INTERCHANGE_MAP
 * This converts the template from the old variable format to the new format
 */
function interchangeVariables(template: string): string {
  let result = template;

  // Sort by length (longest first) to avoid partial replacements
  // This ensures that longer variables like "{{document.statementPeriod}}"
  // are replaced before shorter ones like "{{document.title}}"
  const sortedEntries = Object.entries(VARIABLE_INTERCHANGE_MAP).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [oldVar, newVar] of sortedEntries) {
    // Escape special regex characters and replace exact matches
    // This handles multi-line replacements correctly
    const escapedOldVar = oldVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedOldVar, "g");
    result = result.replace(regex, newVar);
  }

  return result;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

function formatCurrency(value: CurrencyValue): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "";
  }
  return currencyFormatter.format(value);
}

function renderAddress(
  lines: TemplateData["recipient"]["addressLines"]
): string {
  return lines
    .map(
      (line) => `
        <p>${line}</p>
      `
    )
    .join("");
}

function renderTransactions(items: TemplateData["transactions"]): string {
  if (!items.length) {
    return `
      <tr>
        <td colspan="7" class="empty-state">No transactions recorded.</td>
      </tr>
    `;
  }

  return items
    .map(
      (row) => `
        <tr>
          <td>${row.postedDate}</td>
          <td>${row.cardId}</td>
          <td>${row.details}</td>
          <td class="numeric">${formatCurrency(row.withdrawals)}</td>
          <td class="numeric">${formatCurrency(row.deposits)}</td>
          <td class="numeric">${formatCurrency(row.balance)}</td>
        </tr>
      `
    )
    .join("");
}

interface TemplateRenderOptions {
  isSinglePage: boolean;
  pageCount?: number | null;
}

function replaceTokens(
  template: string,
  tokens: Record<string, string>
): string {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (match, token) => {
    if (token in tokens) {
      return tokens[token];
    }
    return match;
  });
}

function buildTemplateReplacements(
  data: TemplateData,
  options: TemplateRenderOptions
): Record<string, string> {
  const replacements = { ...flattenObject(data) };
  replacements["recipient.addressHtml"] = renderAddress(
    data.recipient.addressLines
  );
  replacements["transactions.rows"] = renderTransactions(data.transactions);
  replacements["document.singlePageBodyClass"] = options.isSinglePage
    ? "document--single"
    : (data.document.singlePageBodyClass ?? "");
  const pageCountValue =
    options.pageCount !== undefined && options.pageCount !== null
      ? String(options.pageCount)
      : (data.document.pageCount ?? "");
  replacements["document.pageCount"] = pageCountValue;
  replacements["balances.opening"] = formatCurrency(data.balances.opening);
  replacements["balances.withdrawals"] = formatCurrency(
    data.balances.withdrawals
  );
  replacements["balances.deposits"] = formatCurrency(data.balances.deposits);
  replacements["balances.closing"] = formatCurrency(data.balances.closing);
  replacements["balances.closingLabel"] = data.balances.closingLabel;

  return replacements;
}

function renderTemplate(
  template: string,
  data: TemplateData,
  options: TemplateRenderOptions
): string {
  return replaceTokens(template, buildTemplateReplacements(data, options));
}

function detectPageCount(htmlPath: string): number | null {
  const pythonScript = [
    "from weasyprint import HTML",
    "import sys",
    "",
    "html_path = sys.argv[1]",
    "document = HTML(filename=html_path).render()",
    "print(len(document.pages))",
  ].join("\n");

  const pythonCandidates = [
    process.env.WEASYPRINT_PYTHON?.trim(),
    "python",
    "py",
  ].filter((value): value is string => Boolean(value && value.length));

  const attempts: Array<{
    command: string;
    error: Error | null;
    status: number | null;
    stderr: string;
    stdout: string;
  }> = [];

  for (const command of pythonCandidates) {
    const result = spawnSync(command, ["-c", pythonScript, htmlPath], {
      encoding: "utf-8",
    });

    if (!result.error && result.status === 0) {
      const output = (result.stdout ?? "").trim();
      const pageCount = Number.parseInt(output, 10);
      if (!Number.isNaN(pageCount)) {
        return pageCount;
      }
      attempts.push({
        command,
        error: new Error(
          `Unexpected page count output "${output}" (stderr="${(result.stderr ?? "").trim()}")`
        ),
        status: 0,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      });
      break;
    }

    attempts.push({
      command,
      error: result.error ?? null,
      status: result.status ?? null,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    });

    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      break;
    }
  }

  if (attempts.length) {
    const details = attempts
      .map((attempt) => {
        const parts = [` - ${attempt.command}`];
        if (attempt.error) {
          parts.push(`error=${attempt.error.message}`);
        }
        if (attempt.status !== null) {
          parts.push(`status=${attempt.status}`);
        }
        if (attempt.stderr) {
          parts.push(`stderr=${attempt.stderr.trim()}`);
        }
        return parts.join(" ");
      })
      .join("\n");

    console.warn(
      `Unable to determine page count using Python. Assuming multiple pages.\n${details}`
    );
  }

  return null;
}

async function inlineStyles(
  template: string,
  baseDir: string
): Promise<string> {
  const variablesCssPath = path.resolve(baseDir, "styles", "variables.css");
  const styleCssPath = path.resolve(baseDir, "styles", "style.css");

  const [variablesCss, styleCss] = await Promise.all([
    readFile(variablesCssPath, "utf-8"),
    readFile(styleCssPath, "utf-8"),
  ]);

  const combinedCss = `${variablesCss}\n\n${styleCss}`;

  // Find the first link tag to get its indentation
  const linkTagRegex = /<link\s+rel="stylesheet"\s+href="[^"]*"\s*\/?>/;
  const firstMatch = template.match(linkTagRegex);

  if (!firstMatch || firstMatch.index === undefined) {
    return template;
  }

  // Get indentation from the line containing the first link tag
  const beforeFirstMatch = template.substring(0, firstMatch.index);
  const lastNewlineIndex = beforeFirstMatch.lastIndexOf("\n");
  const lineBeforeMatch = beforeFirstMatch.substring(lastNewlineIndex + 1);
  const indent = lineBeforeMatch.match(/^(\s*)/)?.[1] ?? "    ";

  // Format CSS with proper indentation
  const formattedCss = combinedCss
    .split("\n")
    .map((line) => `${indent}  ${line}`)
    .join("\n");

  // Create the style tag
  const styleTag = `${indent}<style>\n${formattedCss}\n${indent}</style>`;

  // Replace the first link tag with the style tag, remove all others
  let isFirst = true;
  const inlinedTemplate = template.replace(
    /<link\s+rel="stylesheet"\s+href="[^"]*"\s*\/?>\s*/g,
    (match) => {
      if (isFirst) {
        isFirst = false;
        return styleTag + "\n";
      }
      return "";
    }
  );

  return inlinedTemplate;
}

async function generateHtml(
  baseDir: string,
  shouldCreatePdf: boolean
): Promise<void> {
  const dataPath = path.resolve(baseDir, "data.json");
  const templatePath = path.resolve(baseDir, "src", "template.html");
  const stylesDir = path.resolve(baseDir, "styles");
  const assetsDir = path.resolve(baseDir, "assets");

  const [dataRaw, templateRaw] = await Promise.all([
    readFile(dataPath, "utf-8"),
    readFile(templatePath, "utf-8"),
  ]);

  const data = loadJson<TemplateData>(dataRaw);
  const outputDir = path.resolve(baseDir, "dist");
  await ensureDir(outputDir);

  const outputHtmlPath = path.resolve(outputDir, "output.html");
  const initialHtml = renderTemplate(templateRaw, data, {
    isSinglePage: false,
  });

  await writeFile(outputHtmlPath, initialHtml, "utf-8");

  const detectedPageCount = detectPageCount(outputHtmlPath);

  console.log("detectedPageCount:", detectedPageCount);

  const isSinglePage = detectedPageCount !== null && detectedPageCount === 1;

  const html = renderTemplate(templateRaw, data, {
    isSinglePage: isSinglePage,
    pageCount: detectedPageCount,
  });

  // Inline styles into output.html
  const htmlWithInlineStyles = await inlineStyles(html, baseDir);

  if (htmlWithInlineStyles !== initialHtml) {
    await writeFile(outputHtmlPath, htmlWithInlineStyles, "utf-8");
  }

  await copyDirectoryIfExists(stylesDir, path.resolve(outputDir, "styles"));
  await copyDirectoryIfExists(assetsDir, path.resolve(outputDir, "assets"));

  if (shouldCreatePdf) {
    // Interchange variables in template (convert to new format)
    const templateWithInterchangedVars = interchangeVariables(templateRaw);

    // Create template.html with inlined styles in dist folder
    const inlinedTemplate = await inlineStyles(
      templateWithInterchangedVars,
      baseDir
    );
    const templateHtmlPath = path.resolve(outputDir, "template.html");
    await writeFile(templateHtmlPath, inlinedTemplate, "utf-8");
    console.log(
      `Template HTML with inlined styles and interchanged variables generated at ${templateHtmlPath}`
    );
  }

  if (!shouldCreatePdf) {
    console.log(`HTML generated at ${outputHtmlPath}`);
    return;
  }

  const pdfOutputPath = path.resolve(outputDir, "output.pdf");
  runWeasyPrint(outputHtmlPath, pdfOutputPath);

  const pdfStats = await stat(pdfOutputPath);
  console.log(
    `PDF generated at ${pdfOutputPath} (${(pdfStats.size / 1024).toFixed(1)} KiB)`
  );
}

async function main(): Promise<void> {
  const shouldCreatePdf = process.argv.includes("--pdf");
  const projectRoot = path.resolve(__dirname, "..");

  try {
    await generateHtml(projectRoot, shouldCreatePdf);
  } catch (error) {
    console.error("Failed to generate document:", error);
    process.exitCode = 1;
  }
}

void main();
