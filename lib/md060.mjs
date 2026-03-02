// @ts-check

import { filterByTypes } from "../helpers/micromark-helpers.cjs";
import { filterByTypesCached } from "./cache.mjs";
import stringWidth from "string-width";

/** @typedef {import("micromark-extension-gfm-table")} */
/** @typedef {import("markdownlint").MicromarkToken} MicromarkToken */
/** @typedef {import("markdownlint").RuleOnErrorFixInfo} RuleOnErrorFixInfo */
/** @typedef {import("markdownlint").RuleOnErrorInfo} RuleOnErrorInfo */

/**
 * Adds a RuleOnErrorInfo object to a list of RuleOnErrorInfo objects.
 *
 * @param {RuleOnErrorInfo[]} errors List of errors.
 * @param {number} lineNumber Line number.
 * @param {number} column Column number.
 * @param {string} detail Detail message.
 * @param {RuleOnErrorFixInfo} [fixInfo] Fix info.
 */
function addError(errors, lineNumber, column, detail, fixInfo) {
  errors.push({
    lineNumber,
    detail,
    "range": [ column, 1 ],
    fixInfo
  });
}

/**
 * Creates a full-line replacement fix.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {number} lineNumber Line number.
 * @param {string} replacement Replacement line.
 * @returns {RuleOnErrorFixInfo | undefined} Fix info.
 */
function replaceLineFix(lines, lineNumber, replacement) {
  const line = lines[lineNumber - 1];
  return {
    "editColumn": 1,
    "deleteCount": line.length,
    "insertText": replacement
  };
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
 * Gets row data for formatting.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {MicromarkToken} row Micromark row token.
 * @returns {object | null} Row data.
 */
function getRowData(lines, row) {
  const dividerColumns = getTableDividerColumns(lines, row)
    .map((column) => column.actual);
  /* c8 ignore next 3 -- micromark table rows always include at least one divider */
  if (dividerColumns.length === 0) {
    return null;
  }
  const line = lines[row.startLine - 1];
  const rowStartIndex = row.startColumn - 1;
  const rowEndIndex = row.endColumn - 1;
  /** @type {string[]} */
  const segments = [];
  let startIndex = rowStartIndex;
  for (const dividerColumn of dividerColumns) {
    const dividerIndex = dividerColumn - 1;
    segments.push(line.slice(startIndex, dividerIndex));
    startIndex = dividerIndex + 1;
  }
  segments.push(line.slice(startIndex, rowEndIndex));
  const leadingPipe = (dividerColumns[0] === row.startColumn);
  const trailingPipe = (dividerColumns[dividerColumns.length - 1] === (row.endColumn - 1));
  const cellStart = leadingPipe ? 1 : 0;
  const cellEnd = segments.length - (trailingPipe ? 1 : 0);
  return {
    dividerColumns,
    leadingPipe,
    trailingPipe,
    "cells": segments.slice(cellStart, cellEnd).map((segment) => segment.trim()),
    "prefix": line.slice(0, rowStartIndex)
  };
}

/**
 * Formats a row to align with header divider columns.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {Column[]} headerDividerColumns Header divider columns.
 * @param {MicromarkToken} row Micromark row token.
 * @returns {string | null} Formatted row or null.
 */
function formatAlignedRow(lines, headerDividerColumns, row) {
  const rowData = getRowData(lines, row);
  /* c8 ignore next 3 -- guarded by getRowData invariant for micromark table rows */
  if (!rowData) {
    return null;
  }
  const targetColumns = headerDividerColumns
    .slice(0, rowData.dividerColumns.length)
    .map((column) => column.effective);
  if (targetColumns.length !== rowData.dividerColumns.length) {
    return null;
  }
  let line = rowData.prefix;
  let lineEffective = stringWidth(line);
  let dividerIndex = 0;
  if (rowData.leadingPipe) {
    const target = targetColumns[dividerIndex];
    const spaces = target - lineEffective;
    if (spaces < 0) {
      return null;
    }
    line += "".padEnd(spaces);
    lineEffective += spaces;
    line += "|";
    lineEffective++;
    dividerIndex++;
    if (rowData.cells.length > 0) {
      line += " ";
      lineEffective++;
    }
  }
  for (const [ cellIndex, cell ] of rowData.cells.entries()) {
    line += cell;
    lineEffective += stringWidth(cell);
    const isLastCell = (cellIndex === (rowData.cells.length - 1));
    if (!isLastCell || rowData.trailingPipe) {
      const target = targetColumns[dividerIndex];
      const spaces = target - lineEffective;
      if (
        !rowData.leadingPipe &&
        (row.type === "tableDelimiterRow") &&
        (cellIndex === 0) &&
        (cell === "-") &&
        (spaces > 0)
      ) {
        // Avoid creating list-like syntax ("- |") in no-leading-pipe tables.
        return null;
      }
      if (spaces < 1) {
        if (!isLastCell || !rowData.trailingPipe) {
          return null;
        }
      } else {
        line += "".padEnd(spaces);
        lineEffective += spaces;
        line += "|";
        lineEffective++;
        dividerIndex++;
        if (!isLastCell) {
          line += " ";
          lineEffective++;
        }
      }
    }
  }
  return line;
}

/**
 * Returns whether compact-fixing this delimiter row could break parsing.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {MicromarkToken} row Micromark row token.
 * @returns {boolean} True iff compact-fixing is unsafe.
 */
function unsafeCompactDelimiterFix(lines, row) {
  if (row.type !== "tableDelimiterRow") {
    return false;
  }
  const dividerColumns = getTableDividerColumns(lines, row);
  /* c8 ignore next 3 -- micromark table delimiter rows always include a divider */
  if (dividerColumns.length === 0) {
    return false;
  }
  const firstDividerColumn = dividerColumns[0].actual;
  if (firstDividerColumn === row.startColumn) {
    return false;
  }
  const line = lines[row.startLine - 1];
  const firstCell = line
    .slice(row.startColumn - 1, firstDividerColumn - 1)
    .trim();
  return (firstCell === "-");
}

/**
 * Checks the specified table rows for consistency with the "aligned" style.
 *
 * @param {readonly string[]} lines File/string lines.
 * @param {MicromarkToken[]} rows Micromark row tokens.
 * @param {string} detail Detail message.
 * @returns {RuleOnErrorInfo[]} List of errors.
 */
function checkStyleAligned(lines, rows, detail) {
  /** @type {RuleOnErrorInfo[]} */
  const errorInfos = [];
  const headerRow = rows[0];
  const headerDividerColumns = getTableDividerColumns(lines, headerRow);
  for (const row of rows.slice(1)) {
    const remainingHeaderDividerColumns = new Set(headerDividerColumns.map((column) => column.effective));
    const rowDividerColumns = getTableDividerColumns(lines, row);
    for (const dividerColumn of rowDividerColumns) {
      if ((remainingHeaderDividerColumns.size > 0) && !remainingHeaderDividerColumns.delete(dividerColumn.effective)) {
        addError(errorInfos, row.startLine, dividerColumn.actual, detail);
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
        errorsIfAligned.push(...checkStyleAligned(lines, rows, "Table pipe does not align with header for style \"aligned\""));
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
          const compactFixesAllowed = !unsafeCompactDelimiterFix(lines, row);
          const tokensOfInterest = filterByTypes(row.children, [ "tableCellDivider", "tableContent", "whitespace" ]);
          for (let i = 0; i < tokensOfInterest.length; i++) {
            const { startColumn, startLine, type } = tokensOfInterest[i];
            if (type === "tableCellDivider") {
              const previous = tokensOfInterest[i - 1];
              if (previous) {
                if (previous.type === "whitespace") {
                  if (previous.text.length !== 1) {
                    let compactFixInfo = undefined;
                    if (compactFixesAllowed) {
                      compactFixInfo = {
                        "editColumn": previous.startColumn,
                        "deleteCount": previous.text.length,
                        "insertText": " "
                      };
                    }
                    addError(
                      errorsIfCompact,
                      startLine,
                      startColumn,
                      "Table pipe has extra space to the left for style \"compact\"",
                      compactFixInfo
                    );
                  }
                  addError(
                    errorsIfTight,
                    startLine,
                    startColumn,
                    "Table pipe has space to the left for style \"tight\"",
                    {
                      "editColumn": previous.startColumn,
                      "deleteCount": previous.text.length
                    }
                  );
                } else {
                  addError(
                    errorsIfCompact,
                    startLine,
                    startColumn,
                    "Table pipe is missing space to the left for style \"compact\"",
                    compactFixesAllowed ?
                      {
                        "editColumn": startColumn,
                        "insertText": " "
                      } :
                      undefined
                  );
                }
              }
              const next = tokensOfInterest[i + 1];
              if (next) {
                if (next.type === "whitespace") {
                  if (next.endColumn !== row.endColumn) {
                    if (next.text.length !== 1) {
                      let compactFixInfo = undefined;
                      if (compactFixesAllowed) {
                        compactFixInfo = {
                          "editColumn": next.startColumn,
                          "deleteCount": next.text.length,
                          "insertText": " "
                        };
                      }
                      addError(
                        errorsIfCompact,
                        startLine,
                        startColumn,
                        "Table pipe has extra space to the right for style \"compact\"",
                        compactFixInfo
                      );
                    }
                    addError(
                      errorsIfTight,
                      startLine,
                      startColumn,
                      "Table pipe has space to the right for style \"tight\"",
                      {
                        "editColumn": next.startColumn,
                        "deleteCount": next.text.length
                      }
                    );
                  }
                } else {
                  addError(
                    errorsIfCompact,
                    startLine,
                    startColumn,
                    "Table pipe is missing space to the right for style \"compact\"",
                    compactFixesAllowed ?
                      {
                        "editColumn": startColumn + 1,
                        "insertText": " "
                      } :
                      undefined
                  );
                }
              }
            }
          }
        }
      }

      // Report errors for whatever (allowed) style has the fewest
      let chosenStyle = "aligned";
      let errorInfos = errorsIfAligned;
      if (
        styleCompactAllowed &&
        ((errorsIfCompact.length < errorInfos.length) || !styleAlignedAllowed)
      ) {
        chosenStyle = "compact";
        errorInfos = errorsIfCompact;
      }
      if (
        styleTightAllowed &&
        ((errorsIfTight.length < errorInfos.length) || (!styleAlignedAllowed && !styleCompactAllowed))
      ) {
        chosenStyle = "tight";
        errorInfos = errorsIfTight;
      }

      // Add fixes for explicit aligned style.
      if ((chosenStyle === "aligned") && (style === "aligned")) {
        const headerDividerColumns = getTableDividerColumns(lines, rows[0]);
        const rowByLineNumber = new Map(rows.map((row) => [ row.startLine, row ]));
        /** @type {Map<number, RuleOnErrorFixInfo | undefined>} */
        const fixByLineNumber = new Map();
        for (const errorInfo of errorInfos) {
          if (!fixByLineNumber.has(errorInfo.lineNumber)) {
            const row = rowByLineNumber.get(errorInfo.lineNumber);
            const alignedRow = row && formatAlignedRow(lines, headerDividerColumns, row);
            const fixInfo = alignedRow && replaceLineFix(lines, errorInfo.lineNumber, alignedRow);
            fixByLineNumber.set(errorInfo.lineNumber, fixInfo || undefined);
          }
          errorInfo.fixInfo = fixByLineNumber.get(errorInfo.lineNumber);
        }
      }

      for (const errorInfo of errorInfos) {
        onError(errorInfo);
      }
    }
  }
};
