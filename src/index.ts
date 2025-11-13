import { mkdir, readFile, stat, writeFile, cp } from "fs/promises";
import { spawnSync } from "child_process";
import path from "path";

type CurrencyValue = number | null | undefined;

interface TemplateData {
  document: {
    title: string;
    companyName: string;
    companyDescription: string;
    supportEmail: string;
    brandInitial: string;
    meta: {
      statementNumber: string;
      accountNumber: string;
      statementPeriod: string;
      statementDate: string;
      pageCount?: string;
    };
    qrCode: string;
    qrAltText: string;
    legalNotice: string;
    extendedLegalNotice: string;
    pageCount?: string;
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
          <td>${row.transactionDate}</td>
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
    : "";
  replacements["document.isSinglePage"] = options.isSinglePage
    ? "true"
    : "false";
  replacements["document.pageCount"] =
    options.pageCount !== undefined && options.pageCount !== null
      ? String(options.pageCount)
      : "";
  replacements["document.statementNumber"] =
    data.document.meta.statementNumber ?? "";
  replacements["document.accountNumber"] =
    data.document.meta.accountNumber ?? "";
  replacements["document.statementPeriod"] =
    data.document.meta.statementPeriod ?? "";
  replacements["document.statementDate"] =
    data.document.meta.statementDate ?? "";
  replacements["document.pageCount"] =
    data.document.pageCount ?? data.document.meta.pageCount ?? "";
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

  if (html !== initialHtml) {
    await writeFile(outputHtmlPath, html, "utf-8");
  }

  await copyDirectoryIfExists(stylesDir, path.resolve(outputDir, "styles"));
  await copyDirectoryIfExists(assetsDir, path.resolve(outputDir, "assets"));

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
