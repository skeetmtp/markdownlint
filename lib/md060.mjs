// @ts-check

import { filterByTypes } from "../helpers/micromark-helpers.cjs";
import { filterByTypesCached } from "./cache.mjs";
import stringWidth from "string-width";

/** @typedef {import("micromark-extension-gfm-table")} */
/** @typedef {import("markdownlint").MicromarkToken} MicromarkToken */
/** @typedef {import("markdownlint").RuleOnErrorInfo} RuleOnErrorInfo */

/**
 * Adds a RuleOnErrorInfo object to a list of RuleOnErrorInfo objects.
 *
 * @param {RuleOnErrorInfo[]} errors List of errors.
 * @param {number} lineNumber Line number.
 * @param {number} column Column number.
 * @param {string} detail Detail message.
 * @param {import("markdownlint").RuleOnErrorFixInfo} [fixInfo] Fix information.
 */
function addError(errors, lineNumber, column, detail, fixInfo) {
  errors.push({
    lineNumber,
    detail,
    "range": [ column, 1 ],
    ...fixInfo && { fixInfo }
  });
}

/**
 * @typedef Column
 * @property {number} actual Actual column (1-based).
 * @property {number} effective Effective column (1-based).
 */

/**
 * Gets a list of table cell divider columns.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {MicromarkToken} row Micromark row token.
 * @returns {Column[]} Divider columns.
 */
function getTableDividerColumns(lines, row) {
  return filterByTypes(
    row.children,
    [ "tableCellDivider" ]
  ).map(
    (divider) => ({
      "actual": divider.startColumn,
      "effective": stringWidth(lines[row.startLine - 1].slice(0, divider.startColumn - 1))
    })
  );
}

/**
 * Computes a fixed line for a row by aligning pipes with the header.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {MicromarkToken} row Micromark row token.
 * @param {Column[]} rowDividerColumns Row divider columns.
 * @param {Column[]} headerDividerColumns Header divider columns.
 * @returns {string | undefined} Fixed line or undefined if unfixable.
 */
function computeAlignedLine(lines, row, rowDividerColumns, headerDividerColumns) {
  const line = lines[row.startLine - 1];
  if (rowDividerColumns.length !== headerDividerColumns.length) {
    return undefined;
  }
  const n = rowDividerColumns.length;
  let result = "";
  let resultEff = 0;
  for (let i = 0; i < n; i++) {
    const pipeIdx = rowDividerColumns[i].actual - 1;
    const cellStart = (i === 0) ? 0 : rowDividerColumns[i - 1].actual;
    const cellContent = line.slice(cellStart, pipeIdx);
    const targetPipeEff = headerDividerColumns[i].effective;
    const neededCellWidth = targetPipeEff - resultEff;
    if (neededCellWidth < 0) {
      return undefined;
    }
    const cellEffWidth = stringWidth(cellContent);
    if (cellEffWidth <= neededCellWidth) {
      result += cellContent + " ".repeat(neededCellWidth - cellEffWidth) + "|";
    } else {
      // Cell too wide - try trimming trailing whitespace
      const trimmed = cellContent.replace(/\s+$/, "");
      const trimmedEff = stringWidth(trimmed);
      if (trimmedEff <= neededCellWidth) {
        result += trimmed + " ".repeat(neededCellWidth - trimmedEff) + "|";
      } else {
        return undefined;
      }
    }
    resultEff = targetPipeEff + 1;
  }
  const lastPipeIdx = rowDividerColumns[n - 1].actual - 1;
  result += line.slice(lastPipeIdx + 1);
  return result;
}

/**
 * Checks the specified table rows for consistency with the "aligned" style.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {MicromarkToken[]} rows Micromark row tokens.
 * @param {string} detail Detail message.
 * @param {boolean} [fixable] Whether to generate fixInfo.
 * @returns {RuleOnErrorInfo[]} List of errors.
 */
function checkStyleAligned(lines, rows, detail, fixable) {
  /** @type {RuleOnErrorInfo[]} */
  const errorInfos = [];
  const headerRow = rows[0];
  const headerDividerColumns = getTableDividerColumns(lines, headerRow);
  for (const row of rows.slice(1)) {
    const remainingHeaderDividerColumns = new Set(headerDividerColumns.map((column) => column.effective));
    const rowDividerColumns = getTableDividerColumns(lines, row);
    /** @type {Column[]} */
    const rowErrors = [];
    for (const dividerColumn of rowDividerColumns) {
      if ((remainingHeaderDividerColumns.size > 0) && !remainingHeaderDividerColumns.delete(dividerColumn.effective)) {
        rowErrors.push(dividerColumn);
      }
    }
    if (rowErrors.length > 0) {
      const line = lines[row.startLine - 1];
      const isDelimiterRow = row.type === "tableDelimiterRow";
      const fixedLine = (fixable && !isDelimiterRow) ? computeAlignedLine(lines, row, rowDividerColumns, headerDividerColumns) : undefined;
      const firstFixInfo = (fixedLine && fixedLine !== line) ? {
        "editColumn": 1,
        "deleteCount": line.length,
        "insertText": fixedLine
      } : undefined;
      addError(errorInfos, row.startLine, rowErrors[0].actual, detail, firstFixInfo);
      for (let i = 1; i < rowErrors.length; i++) {
        addError(errorInfos, row.startLine, rowErrors[i].actual, detail);
      }
    }
  }
  return errorInfos;
}

/** @type {import("markdownlint").Rule} */
export default {
  "names": [ "MD060", "table-column-style" ],
  "description": "Table column style",
  "tags": [ "table" ],
  "parser": "micromark",
  "function": function MD060(params, onError) {
    const style = String(params.config.style || "any");
    const styleAlignedAllowed = (style === "any") || (style === "aligned");
    const styleCompactAllowed = (style === "any") || (style === "compact");
    const styleTightAllowed = (style === "any") || (style === "tight");
    const alignedDelimiter = !!params.config.aligned_delimiter;
    const lines = params.lines;

    // Scan all tables/rows
    const tables = filterByTypesCached([ "table" ]);
    for (const table of tables) {
      const rows = filterByTypes(table.children, [ "tableDelimiterRow", "tableRow" ]);

      // Determine errors for style "aligned"
      /** @type {RuleOnErrorInfo[]} */
      const errorsIfAligned = [];
      if (styleAlignedAllowed) {
        errorsIfAligned.push(...checkStyleAligned(lines, rows, "Table pipe does not align with header for style \"aligned\"", style === "aligned"));
      }

      // Determine errors for styles "compact" and "tight"
      /** @type {RuleOnErrorInfo[]} */
      const errorsIfCompact = [];
      /** @type {RuleOnErrorInfo[]} */
      const errorsIfTight = [];
      if (
        (styleCompactAllowed || styleTightAllowed) &&
        !(styleAlignedAllowed && (errorsIfAligned.length === 0))
      ) {
        if (alignedDelimiter) {
          const errorInfos = checkStyleAligned(lines, rows.slice(0, 2), "Table pipe does not align with header for option \"aligned_delimiter\"");
          errorsIfCompact.push(...errorInfos);
          errorsIfTight.push(...errorInfos);
        }
        for (const row of rows) {
          // Skip fixInfo for delimiter rows (fixing spacing can break table parsing)
          const isDelimiterRow = row.type === "tableDelimiterRow";
          const tokensOfInterest = filterByTypes(row.children, [ "tableCellDivider", "tableContent", "whitespace" ]);
          for (let i = 0; i < tokensOfInterest.length; i++) {
            const { startColumn, startLine, type } = tokensOfInterest[i];
            if (type === "tableCellDivider") {
              const previous = tokensOfInterest[i - 1];
              if (previous) {
                if (previous.type === "whitespace") {
                  if (previous.text.length !== 1) {
                    addError(errorsIfCompact, startLine, startColumn, "Table pipe has extra space to the left for style \"compact\"",
                      isDelimiterRow ? undefined : { "editColumn": previous.startColumn, "deleteCount": previous.text.length, "insertText": " " });
                  }
                  addError(errorsIfTight, startLine, startColumn, "Table pipe has space to the left for style \"tight\"",
                    isDelimiterRow ? undefined : { "editColumn": previous.startColumn, "deleteCount": previous.text.length });
                } else {
                  addError(errorsIfCompact, startLine, startColumn, "Table pipe is missing space to the left for style \"compact\"",
                    isDelimiterRow ? undefined : { "editColumn": startColumn, "deleteCount": 0, "insertText": " " });
                }
              }
              const next = tokensOfInterest[i + 1];
              if (next) {
                if (next.type === "whitespace") {
                  if (next.endColumn !== row.endColumn) {
                    if (next.text.length !== 1) {
                      addError(errorsIfCompact, startLine, startColumn, "Table pipe has extra space to the right for style \"compact\"",
                        isDelimiterRow ? undefined : { "editColumn": next.startColumn, "deleteCount": next.text.length, "insertText": " " });
                    }
                    addError(errorsIfTight, startLine, startColumn, "Table pipe has space to the right for style \"tight\"",
                      isDelimiterRow ? undefined : { "editColumn": next.startColumn, "deleteCount": next.text.length });
                  }
                } else {
                  addError(errorsIfCompact, startLine, startColumn, "Table pipe is missing space to the right for style \"compact\"",
                    isDelimiterRow ? undefined : { "editColumn": startColumn + 1, "deleteCount": 0, "insertText": " " });
                }
              }
            }
          }
        }
      }

      // Report errors for whatever (allowed) style has the fewest
      let errorInfos = errorsIfAligned;
      if (
        styleCompactAllowed &&
        ((errorsIfCompact.length < errorInfos.length) || !styleAlignedAllowed)
      ) {
        errorInfos = errorsIfCompact;
      }
      if (
        styleTightAllowed &&
        ((errorsIfTight.length < errorInfos.length) || (!styleAlignedAllowed && !styleCompactAllowed))
      ) {
        errorInfos = errorsIfTight;
      }
      for (const errorInfo of errorInfos) {
        onError(errorInfo);
      }
    }
  }
};
