#!/usr/bin/env node
/** User-side companion that exposes one explicitly selected local folder. */

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';
import { browseLocalWorkspace } from './local-workspace-browser.js';
import {
  captureDesktopScreen,
  sendDesktopInput,
} from './local-workspace-desktop.js';
import { CompanionError } from './local-workspace-error.js';
import {
  LOCAL_WORKSPACE_MAX_MESSAGE_BYTES,
  LOCAL_WORKSPACE_PROTOCOL_VERSION,
  parseWireObject,
  type HostToCompanionMessage,
  type LocalWorkspaceOperation,
  type LocalWorkspaceRequest,
  type LocalWorkspaceResponse,
} from './local-workspace-protocol.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const DEFAULT_OFFICE_TIMEOUT_MS = 180_000;
const MAX_OFFICE_OPERATIONS = 100;
const MAX_OFFICE_TEXT_CHARS = 200_000;
const MAX_OFFICE_CELLS = 50_000;
const MAX_OFFICE_ROWS = 5_000;
const MAX_OFFICE_COLUMNS = 200;
const WINDOWS_PROTOCOL = 'dsh-local-workspace';
const WINDOWS_PROTOCOL_PREFIXES = [
  `${WINDOWS_PROTOCOL}://connect?`,
  `${WINDOWS_PROTOCOL}://connect/?`,
] as const;
const MAX_LAUNCH_URI_LENGTH = 4_096;
const MAX_SERVER_URL_LENGTH = 2_048;

/** Resolved companion configuration, including both agent-facing grants. */
export interface CompanionConfig {
  server: string;
  token?: string;
  workspaceId: string;
  deviceName: string;
  workspaceName: string;
  root: string;
  shellEnabled: boolean;
  /** Whether the agent may capture this screen and drive its mouse and keyboard. */
  desktopControl: boolean;
}

interface CliOptions {
  configPath: string;
  pairCode?: string;
  launchTicket?: string;
  launchWorkspaceId?: string;
  server?: string;
  folder?: string;
  deviceName?: string;
  workspaceName?: string;
  allowShell: boolean;
  allowDesktop: boolean;
  help: boolean;
  setup: boolean;
}

interface RunningOperation {
  controller: AbortController;
}

/**
 * PowerShell helpers shared by every Office automation script.
 *
 * Each action runs its own short-lived PowerShell process with only the
 * functions that action needs, so a Word edit never parses the Excel or
 * PowerPoint bodies. The envelope written by Write-Success and Write-Failure is
 * the contract runOfficePowerShell parses.
 */
const OFFICE_SCRIPT_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Success($Value) {
  [Console]::Out.Write((@{ ok = $true; value = $Value } | ConvertTo-Json -Depth 16 -Compress))
}

function Write-Failure([string]$Code, [string]$Message) {
  [Console]::Out.Write((@{ ok = $false; code = $Code; error = $Message } | ConvertTo-Json -Depth 8 -Compress))
}

function Throw-Coded([string]$Code, [string]$Message) {
  throw [System.InvalidOperationException]::new($Code + '|' + $Message)
}

function Has-Property($Value, [string]$Name) {
  return $null -ne $Value.PSObject.Properties[$Name]
}

function Test-ProgId([string]$ProgId) {
  try {
    return $null -ne [type]::GetTypeFromProgID($ProgId)
  } catch {
    return $false
  }
}

function Convert-Color([string]$Color) {
  $rgb = [Convert]::ToInt32($Color.Substring(1), 16)
  $red = ($rgb -shr 16) -band 255
  $green = ($rgb -shr 8) -band 255
  $blue = $rgb -band 255
  return ($blue -shl 16) -bor ($green -shl 8) -bor $red
}
`;

/**
 * Probe which Office suites can automate Word, Excel and PowerPoint.
 *
 * `office`, `wps` and `preferred` describe Word alone and predate the Excel and
 * PowerPoint actions; they stay at the top level so a host built before those
 * actions keeps reading the field it expects. `apps` carries the same three
 * fields per application.
 */
const WINDOWS_OFFICE_STATUS_SCRIPT = OFFICE_SCRIPT_PRELUDE + String.raw`
function Get-SuiteAvailability([string]$OfficeProgId, [string]$WpsProgId) {
  $office = Test-ProgId $OfficeProgId
  $wps = Test-ProgId $WpsProgId
  return [PSCustomObject]@{
    office = $office
    wps = $wps
    preferred = $(if ($office) { 'office' } elseif ($wps) { 'wps' } else { $null })
  }
}

try {
  $word = Get-SuiteAvailability 'Word.Application' 'kwps.Application'
  $excel = Get-SuiteAvailability 'Excel.Application' 'ket.Application'
  $powerpoint = Get-SuiteAvailability 'PowerPoint.Application' 'kwpp.Application'
  Write-Success ([PSCustomObject]@{
    platform = 'win32'
    office = $word.office
    wps = $word.wps
    preferred = $word.preferred
    apps = [PSCustomObject]@{
      word = $word
      excel = $excel
      powerpoint = $powerpoint
    }
  })
} catch {
  Write-Failure 'OFFICE_AUTOMATION_FAILED' ([string]$_.Exception.Message)
}
`;

const WINDOWS_WORD_AUTOMATION_SCRIPT = OFFICE_SCRIPT_PRELUDE + String.raw`
function New-WordApplication([string]$Provider) {
  $candidates = @()
  if ($Provider -eq 'auto' -or $Provider -eq 'office') {
    $candidates += [PSCustomObject]@{ provider = 'office'; progId = 'Word.Application' }
  }
  if ($Provider -eq 'auto' -or $Provider -eq 'wps') {
    $candidates += [PSCustomObject]@{ provider = 'wps'; progId = 'kwps.Application' }
  }
  foreach ($candidate in $candidates) {
    try {
      $application = New-Object -ComObject $candidate.progId
      return [PSCustomObject]@{
        application = $application
        provider = $candidate.provider
        progId = $candidate.progId
      }
    } catch {
      continue
    }
  }
  Throw-Coded 'NO_OFFICE_PROVIDER' '未检测到可用的 Microsoft Word 或 WPS 文字 COM 自动化接口'
}

function Get-Paragraph($Document, [int]$Index) {
  if ($Index -lt 1 -or $Index -gt $Document.Paragraphs.Count) {
    Throw-Coded 'PARAGRAPH_OUT_OF_RANGE' ('段落索引超出范围：' + $Index)
  }
  return $Document.Paragraphs.Item($Index)
}

function Set-ParagraphFormat($Paragraph, $Operation) {
  if (Has-Property $Operation 'style') { $Paragraph.Range.Style = [string]$Operation.style }
  if (Has-Property $Operation 'alignment') {
    $alignments = @{ left = 0; center = 1; right = 2; justify = 3 }
    $Paragraph.Range.ParagraphFormat.Alignment = $alignments[[string]$Operation.alignment]
  }
  if (Has-Property $Operation 'bold') { $Paragraph.Range.Font.Bold = $(if ([bool]$Operation.bold) { 1 } else { 0 }) }
  if (Has-Property $Operation 'italic') { $Paragraph.Range.Font.Italic = $(if ([bool]$Operation.italic) { 1 } else { 0 }) }
  if (Has-Property $Operation 'fontName') { $Paragraph.Range.Font.Name = [string]$Operation.fontName }
  if (Has-Property $Operation 'fontSize') { $Paragraph.Range.Font.Size = [double]$Operation.fontSize }
  if (Has-Property $Operation 'color') { $Paragraph.Range.Font.Color = Convert-Color ([string]$Operation.color) }
}

function Open-WordDocument($Application, [string]$Path) {
  try {
    return $Application.Documents.Open($Path, $false, $false, $false)
  } catch {
    return $Application.Documents.Open($Path)
  }
}

function Save-NewWordDocument($Document, [string]$Path) {
  try {
    $Document.SaveAs2($Path)
  } catch {
    $Document.SaveAs($Path)
  }
}

function Read-WordDocument($Document, [int]$MaxChars, [string]$Provider, [string]$ProgId) {
  $text = [string]$Document.Content.Text
  $truncated = $text.Length -gt $MaxChars
  if ($truncated) { $text = $text.Substring(0, $MaxChars) }
  $paragraphs = @()
  $paragraphLimit = [Math]::Min([int]$Document.Paragraphs.Count, 500)
  for ($index = 1; $index -le $paragraphLimit; $index++) {
    $paragraph = $Document.Paragraphs.Item($index)
    $paragraphText = ([string]$paragraph.Range.Text) -replace '[\r\a]+$', ''
    if ($paragraphText.Length -gt 2000) { $paragraphText = $paragraphText.Substring(0, 2000) }
    $paragraphs += [PSCustomObject]@{ index = $index; text = $paragraphText }
  }
  $tables = @()
  $tableLimit = [Math]::Min([int]$Document.Tables.Count, 20)
  $remainingCells = 1000
  for ($tableIndex = 1; $tableIndex -le $tableLimit; $tableIndex++) {
    if ($remainingCells -le 0) { break }
    $table = $Document.Tables.Item($tableIndex)
    $rows = @()
    $rowLimit = [Math]::Min([int]$table.Rows.Count, 200)
    $columnLimit = [Math]::Min([int]$table.Columns.Count, 50)
    for ($rowIndex = 1; $rowIndex -le $rowLimit; $rowIndex++) {
      if ($remainingCells -le 0) { break }
      $cells = @()
      for ($columnIndex = 1; $columnIndex -le $columnLimit; $columnIndex++) {
        if ($remainingCells -le 0) { break }
        try {
          $cellText = ([string]$table.Cell($rowIndex, $columnIndex).Range.Text) -replace '[\r\a]+$', ''
        } catch {
          $cellText = ''
        }
        if ($cellText.Length -gt 1000) { $cellText = $cellText.Substring(0, 1000) }
        $cells += $cellText
        $remainingCells--
      }
      $rows += ,$cells
    }
    $tables += [PSCustomObject]@{ index = $tableIndex; rows = $rows }
  }
  return [PSCustomObject]@{
    provider = $Provider
    progId = $ProgId
    text = $text
    truncated = $truncated
    paragraphCount = [int]$Document.Paragraphs.Count
    tableCount = [int]$Document.Tables.Count
    paragraphs = $paragraphs
    tables = $tables
  }
}

function Apply-WordOperation($Document, $Operation, [System.Collections.ArrayList]$Exports) {
  switch ([string]$Operation.type) {
    'replace_text' {
      $range = $Document.Content
      $find = $range.Find
      $replaceMode = $(if ([bool]$Operation.replaceAll) { 2 } else { 1 })
      $null = $find.Execute(
        [string]$Operation.find,
        [bool]$Operation.matchCase,
        [bool]$Operation.wholeWord,
        $false,
        $false,
        $false,
        $true,
        1,
        $false,
        [string]$Operation.replace,
        $replaceMode
      )
    }
    'append_paragraph' {
      $paragraph = $Document.Paragraphs.Add()
      $paragraph.Range.Text = [string]$Operation.text + [char]13
      Set-ParagraphFormat $paragraph $Operation
    }
    'insert_paragraph' {
      $index = [int]$Operation.paragraph
      if ($index -eq $Document.Paragraphs.Count + 1) {
        $paragraph = $Document.Paragraphs.Add()
        $paragraph.Range.Text = [string]$Operation.text + [char]13
      } else {
        $paragraph = Get-Paragraph $Document $index
        $paragraph.Range.InsertBefore([string]$Operation.text + [char]13)
        $paragraph = $Document.Paragraphs.Item($index)
      }
      Set-ParagraphFormat $paragraph $Operation
    }
    'set_paragraph' {
      $paragraph = Get-Paragraph $Document ([int]$Operation.paragraph)
      if (Has-Property $Operation 'text') {
        $paragraph.Range.Text = [string]$Operation.text + [char]13
        $paragraph = Get-Paragraph $Document ([int]$Operation.paragraph)
      }
      Set-ParagraphFormat $paragraph $Operation
    }
    'delete_paragraph' {
      $paragraph = Get-Paragraph $Document ([int]$Operation.paragraph)
      $null = $paragraph.Range.Delete()
    }
    'add_table' {
      if (Has-Property $Operation 'afterParagraph') {
        $range = (Get-Paragraph $Document ([int]$Operation.afterParagraph)).Range
      } else {
        $range = $Document.Content
      }
      $range.Collapse(0)
      $rows = @($Operation.rows)
      $columns = @($rows[0]).Count
      $table = $Document.Tables.Add($range, $rows.Count, $columns)
      for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
        $cells = @($rows[$rowIndex])
        for ($columnIndex = 0; $columnIndex -lt $columns; $columnIndex++) {
          $table.Cell($rowIndex + 1, $columnIndex + 1).Range.Text = [string]$cells[$columnIndex]
        }
      }
      if ([bool]$Operation.header) { $table.Rows.Item(1).Range.Font.Bold = 1 }
      if (Has-Property $Operation 'style') { $table.Style = [string]$Operation.style }
    }
    'set_header' {
      for ($index = 1; $index -le $Document.Sections.Count; $index++) {
        $Document.Sections.Item($index).Headers.Item(1).Range.Text = [string]$Operation.text
      }
    }
    'set_footer' {
      for ($index = 1; $index -le $Document.Sections.Count; $index++) {
        $Document.Sections.Item($index).Footers.Item(1).Range.Text = [string]$Operation.text
      }
    }
    'insert_image' {
      if (Has-Property $Operation 'paragraph') {
        $range = (Get-Paragraph $Document ([int]$Operation.paragraph)).Range
      } else {
        $range = $Document.Content
      }
      $range.Collapse(0)
      $image = $Document.InlineShapes.AddPicture([string]$Operation.imagePath, $false, $true, $range)
      if (Has-Property $Operation 'widthPoints') { $image.Width = [double]$Operation.widthPoints }
      if (Has-Property $Operation 'heightPoints') { $image.Height = [double]$Operation.heightPoints }
    }
    'page_break' {
      if (Has-Property $Operation 'paragraph') {
        $range = (Get-Paragraph $Document ([int]$Operation.paragraph)).Range
      } else {
        $range = $Document.Content
      }
      $range.Collapse(0)
      $range.InsertBreak(7)
    }
    'export_pdf' {
      $null = $Exports.Add([string]$Operation.outputPath)
    }
    default {
      Throw-Coded 'INVALID_ARGUMENT' ('不支持的 Word 操作：' + [string]$Operation.type)
    }
  }
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $resolved = New-WordApplication ([string]$request.provider)
  $application = $resolved.application
  $document = $null
  try {
    try { $application.Visible = $false } catch { }
    try { $application.DisplayAlerts = 0 } catch { }
    $application.AutomationSecurity = 3
    if ([string]$request.action -eq 'read_word') {
      $document = Open-WordDocument $application ([string]$request.path)
      Write-Success (Read-WordDocument $document ([int]$request.maxChars) $resolved.provider $resolved.progId)
    } else {
      if ([bool]$request.create) {
        $document = $application.Documents.Add()
      } else {
        $document = Open-WordDocument $application ([string]$request.path)
      }
      $exports = New-Object System.Collections.ArrayList
      $applied = 0
      foreach ($operation in @($request.operations)) {
        Apply-WordOperation $document $operation $exports
        $applied++
      }
      if ([bool]$request.create) {
        Save-NewWordDocument $document ([string]$request.workPath)
      } else {
        $document.Save()
      }
      foreach ($outputPath in $exports) {
        $document.ExportAsFixedFormat([string]$outputPath, 17)
      }
      Write-Success ([PSCustomObject]@{
        provider = $resolved.provider
        progId = $resolved.progId
        created = [bool]$request.create
        operationsApplied = $applied
      })
    }
  } finally {
    if ($null -ne $document) {
      try { $document.Close(0) } catch { }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) } catch { }
    }
    if ($null -ne $application) {
      try { $application.Quit() } catch { }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) } catch { }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
} catch {
  $message = [string]$_.Exception.Message
  $code = 'OFFICE_AUTOMATION_FAILED'
  $separator = $message.IndexOf('|')
  if ($separator -gt 0) {
    $code = $message.Substring(0, $separator)
    $message = $message.Substring($separator + 1)
  }
  Write-Failure $code $message
}
`;

/**
 * Excel and WPS Spreadsheets automation.
 *
 * Reads go through Range.Value so a date-formatted cell arrives as a DateTime
 * and is emitted as an ISO string; Value2 is the fallback when a provider
 * refuses the parameterized property, and dates then arrive as serial numbers.
 * Writes address cells by A1 reference or by row and column, and the workbook
 * is saved only after every requested operation succeeds.
 */
const WINDOWS_EXCEL_AUTOMATION_SCRIPT = OFFICE_SCRIPT_PRELUDE + String.raw`
function New-ExcelApplication([string]$Provider) {
  $candidates = @()
  if ($Provider -eq 'auto' -or $Provider -eq 'office') {
    $candidates += [PSCustomObject]@{ provider = 'office'; progId = 'Excel.Application' }
  }
  if ($Provider -eq 'auto' -or $Provider -eq 'wps') {
    $candidates += [PSCustomObject]@{ provider = 'wps'; progId = 'ket.Application' }
  }
  foreach ($candidate in $candidates) {
    try {
      $application = New-Object -ComObject $candidate.progId
      return [PSCustomObject]@{
        application = $application
        provider = $candidate.provider
        progId = $candidate.progId
      }
    } catch {
      continue
    }
  }
  Throw-Coded 'NO_OFFICE_PROVIDER' '未检测到可用的 Microsoft Excel 或 WPS 表格 COM 自动化接口'
}

function Get-Worksheet($Workbook, $Operation) {
  if (-not (Has-Property $Operation 'sheet')) { return $Workbook.ActiveSheet }
  $sheet = $Operation.sheet
  if ($sheet -is [int] -or $sheet -is [long] -or $sheet -is [double]) {
    $index = [int]$sheet
    if ($index -lt 1 -or $index -gt $Workbook.Worksheets.Count) {
      Throw-Coded 'SHEET_NOT_FOUND' ('工作表索引超出范围：' + $index)
    }
    return $Workbook.Worksheets.Item($index)
  }
  $name = [string]$sheet
  foreach ($candidate in $Workbook.Worksheets) {
    if ([string]$candidate.Name -eq $name) { return $candidate }
  }
  Throw-Coded 'SHEET_NOT_FOUND' ('找不到工作表：' + $name)
}

function Get-TargetRange($Worksheet, $Operation, [string]$Property) {
  $reference = [string]$Operation.$Property
  try {
    return $Worksheet.Range($reference)
  } catch {
    Throw-Coded 'INVALID_ARGUMENT' ('无法解析区域引用：' + $reference)
  }
}

function Convert-CellValue($Value) {
  if ($null -eq $Value) { return '' }
  if ($Value -is [datetime]) { return $Value.ToString('yyyy-MM-ddTHH:mm:ss') }
  if ($Value -is [bool]) { return $(if ($Value) { 'TRUE' } else { 'FALSE' }) }
  return [string]$Value
}

function Read-RangeRows($Range, [int]$MaxCells, [ref]$Truncated) {
  $rows = @()
  if ($null -eq $Range) { return $rows }
  $values = $null
  try {
    $values = $Range.Value()
  } catch {
    $values = $Range.Value2
  }
  if ($null -eq $values) { return $rows }
  if ($values -isnot [Array]) {
    if ($MaxCells -lt 1) { $Truncated.Value = $true; return $rows }
    return @(, @((Convert-CellValue $values)))
  }
  $firstRow = $values.GetLowerBound(0)
  $lastRow = $values.GetUpperBound(0)
  $firstColumn = $values.GetLowerBound(1)
  $lastColumn = $values.GetUpperBound(1)
  $remaining = $MaxCells
  for ($row = $firstRow; $row -le $lastRow; $row++) {
    if ($remaining -le 0) { $Truncated.Value = $true; break }
    $cells = @()
    for ($column = $firstColumn; $column -le $lastColumn; $column++) {
      if ($remaining -le 0) { $Truncated.Value = $true; break }
      $cells += (Convert-CellValue $values.GetValue($row, $column))
      $remaining--
    }
    $rows += , $cells
  }
  return $rows
}

function Read-ExcelWorkbook($Workbook, $Request, [string]$Provider, [string]$ProgId) {
  $maxCells = [int]$Request.maxCells
  $wanted = $null
  if (Has-Property $Request 'sheet') { $wanted = $Request.sheet }
  $sheets = @()
  $truncated = $false
  $remaining = $maxCells
  $sheetCount = [int]$Workbook.Worksheets.Count
  for ($index = 1; $index -le $sheetCount; $index++) {
    $worksheet = $Workbook.Worksheets.Item($index)
    if ($null -ne $wanted) {
      if ($wanted -is [int] -or $wanted -is [long] -or $wanted -is [double]) {
        if ([int]$wanted -ne $index) { continue }
      } elseif ([string]$worksheet.Name -ne [string]$wanted) {
        continue
      }
    }
    $used = $worksheet.UsedRange
    $rowCount = 0
    $columnCount = 0
    $firstRow = 1
    $firstColumn = 1
    if ($null -ne $used) {
      $rowCount = [int]$used.Rows.Count
      $columnCount = [int]$used.Columns.Count
      $firstRow = [int]$used.Row
      $firstColumn = [int]$used.Column
    }
    $wasTruncated = $false
    $rows = Read-RangeRows $used $remaining ([ref]$wasTruncated)
    if ($wasTruncated) { $truncated = $true }
    $consumed = 0
    foreach ($row in $rows) { $consumed += $row.Count }
    $remaining -= $consumed
    $sheets += [PSCustomObject]@{
      index = $index
      name = [string]$worksheet.Name
      firstRow = $firstRow
      firstColumn = $firstColumn
      rowCount = $rowCount
      columnCount = $columnCount
      rows = $rows
    }
  }
  return [PSCustomObject]@{
    provider = $Provider
    progId = $ProgId
    sheetCount = $sheetCount
    truncated = $truncated
    sheets = $sheets
  }
}

function Set-RangeFormat($Range, $Operation) {
  if (Has-Property $Operation 'bold') { $Range.Font.Bold = [bool]$Operation.bold }
  if (Has-Property $Operation 'italic') { $Range.Font.Italic = [bool]$Operation.italic }
  if (Has-Property $Operation 'fontName') { $Range.Font.Name = [string]$Operation.fontName }
  if (Has-Property $Operation 'fontSize') { $Range.Font.Size = [double]$Operation.fontSize }
  if (Has-Property $Operation 'color') { $Range.Font.Color = Convert-Color ([string]$Operation.color) }
  if (Has-Property $Operation 'background') { $Range.Interior.Color = Convert-Color ([string]$Operation.background) }
  if (Has-Property $Operation 'numberFormat') { $Range.NumberFormat = [string]$Operation.numberFormat }
  if (Has-Property $Operation 'wrap') { $Range.WrapText = [bool]$Operation.wrap }
  if (Has-Property $Operation 'alignment') {
    $alignments = @{ left = -4131; center = -4108; right = -4152 }
    $Range.HorizontalAlignment = $alignments[[string]$Operation.alignment]
  }
  if (Has-Property $Operation 'merge') {
    if ([bool]$Operation.merge) { $Range.Merge() } else { $Range.UnMerge() }
  }
}

function Write-Rows($Worksheet, [int]$StartRow, [int]$StartColumn, $Rows) {
  $rowIndex = $StartRow
  foreach ($row in @($Rows)) {
    $columnIndex = $StartColumn
    foreach ($cell in @($row)) {
      $text = [string]$cell
      if ($text.StartsWith('=')) {
        $Worksheet.Cells.Item($rowIndex, $columnIndex).Formula = $text
      } else {
        $Worksheet.Cells.Item($rowIndex, $columnIndex).Value2 = $text
      }
      $columnIndex++
    }
    $rowIndex++
  }
}

function Get-LastUsedRow($Worksheet) {
  $used = $Worksheet.UsedRange
  if ($null -eq $used) { return 0 }
  if ([int]$used.Rows.Count -eq 1 -and [string]$Worksheet.Cells.Item(1, 1).Value2 -eq '') { return 0 }
  return [int]$used.Row + [int]$used.Rows.Count - 1
}

function Apply-ExcelOperation($Workbook, $Operation, [System.Collections.ArrayList]$Exports) {
  switch ([string]$Operation.type) {
    'set_cells' {
      $worksheet = Get-Worksheet $Workbook $Operation
      Write-Rows $worksheet ([int]$Operation.row) ([int]$Operation.column) $Operation.rows
    }
    'append_rows' {
      $worksheet = Get-Worksheet $Workbook $Operation
      $startRow = (Get-LastUsedRow $worksheet) + 1
      Write-Rows $worksheet $startRow 1 $Operation.rows
    }
    'set_formula' {
      $worksheet = Get-Worksheet $Workbook $Operation
      (Get-TargetRange $worksheet $Operation 'range').Formula = [string]$Operation.formula
    }
    'clear_range' {
      $worksheet = Get-Worksheet $Workbook $Operation
      (Get-TargetRange $worksheet $Operation 'range').ClearContents()
    }
    'format_range' {
      $worksheet = Get-Worksheet $Workbook $Operation
      Set-RangeFormat (Get-TargetRange $worksheet $Operation 'range') $Operation
    }
    'set_column_width' {
      $worksheet = Get-Worksheet $Workbook $Operation
      (Get-TargetRange $worksheet $Operation 'range').EntireColumn.ColumnWidth = [double]$Operation.width
    }
    'set_row_height' {
      $worksheet = Get-Worksheet $Workbook $Operation
      (Get-TargetRange $worksheet $Operation 'range').EntireRow.RowHeight = [double]$Operation.height
    }
    'autofit' {
      $worksheet = Get-Worksheet $Workbook $Operation
      if (Has-Property $Operation 'range') {
        $null = (Get-TargetRange $worksheet $Operation 'range').EntireColumn.AutoFit()
      } else {
        $null = $worksheet.UsedRange.EntireColumn.AutoFit()
      }
    }
    'add_sheet' {
      $worksheet = $Workbook.Worksheets.Add()
      if (Has-Property $Operation 'name') { $worksheet.Name = [string]$Operation.name }
    }
    'rename_sheet' {
      (Get-Worksheet $Workbook $Operation).Name = [string]$Operation.name
    }
    'delete_sheet' {
      if ([int]$Workbook.Worksheets.Count -le 1) {
        Throw-Coded 'INVALID_ARGUMENT' '工作簿必须至少保留一个工作表'
      }
      (Get-Worksheet $Workbook $Operation).Delete()
    }
    'replace_text' {
      $worksheet = Get-Worksheet $Workbook $Operation
      $lookAt = $(if ([bool]$Operation.wholeCell) { 1 } else { 2 })
      $null = $worksheet.Cells.Replace([string]$Operation.find, [string]$Operation.replace, $lookAt, 1, $false, $false, [bool]$Operation.matchCase)
    }
    'insert_image' {
      $worksheet = Get-Worksheet $Workbook $Operation
      $anchor = Get-TargetRange $worksheet $Operation 'range'
      $width = $(if (Has-Property $Operation 'widthPoints') { [double]$Operation.widthPoints } else { -1 })
      $height = $(if (Has-Property $Operation 'heightPoints') { [double]$Operation.heightPoints } else { -1 })
      $null = $worksheet.Shapes.AddPicture([string]$Operation.imagePath, $false, $true, [double]$anchor.Left, [double]$anchor.Top, $width, $height)
    }
    'export_pdf' {
      $null = $Exports.Add([string]$Operation.outputPath)
    }
    default {
      Throw-Coded 'INVALID_ARGUMENT' ('不支持的 Excel 操作：' + [string]$Operation.type)
    }
  }
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $resolved = New-ExcelApplication ([string]$request.provider)
  $application = $resolved.application
  $workbook = $null
  try {
    try { $application.Visible = $false } catch { }
    try { $application.DisplayAlerts = $false } catch { }
    try { $application.AutomationSecurity = 3 } catch { }
    if ([string]$request.action -eq 'read_excel') {
      $workbook = $application.Workbooks.Open([string]$request.path, $false, $true)
      Write-Success (Read-ExcelWorkbook $workbook $request $resolved.provider $resolved.progId)
    } else {
      if ([bool]$request.create) {
        $workbook = $application.Workbooks.Add()
      } else {
        $workbook = $application.Workbooks.Open([string]$request.path)
      }
      $exports = New-Object System.Collections.ArrayList
      $applied = 0
      foreach ($operation in @($request.operations)) {
        Apply-ExcelOperation $workbook $operation $exports
        $applied++
      }
      if ([bool]$request.create) {
        $workbook.SaveAs([string]$request.workPath)
      } else {
        $workbook.Save()
      }
      foreach ($outputPath in $exports) {
        $workbook.ExportAsFixedFormat(0, [string]$outputPath)
      }
      Write-Success ([PSCustomObject]@{
        provider = $resolved.provider
        progId = $resolved.progId
        created = [bool]$request.create
        operationsApplied = $applied
      })
    }
  } finally {
    if ($null -ne $workbook) {
      try { $workbook.Close($false) } catch { }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook) } catch { }
    }
    if ($null -ne $application) {
      try { $application.Quit() } catch { }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) } catch { }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
} catch {
  $message = [string]$_.Exception.Message
  $code = 'OFFICE_AUTOMATION_FAILED'
  $separator = $message.IndexOf('|')
  if ($separator -gt 0) {
    $code = $message.Substring(0, $separator)
    $message = $message.Substring($separator + 1)
  }
  Write-Failure $code $message
}
`;

/**
 * PowerPoint and WPS Presentation automation.
 *
 * Presentations open without a window rather than hidden: PowerPoint rejects
 * `Visible = $false` on the application object, so `Open` receives
 * `WithWindow = $false` instead. Shapes are addressed by their 1-based index
 * within a slide, matching what read_ppt reports.
 */
const WINDOWS_POWERPOINT_AUTOMATION_SCRIPT = OFFICE_SCRIPT_PRELUDE + String.raw`
function New-PowerPointApplication([string]$Provider) {
  $candidates = @()
  if ($Provider -eq 'auto' -or $Provider -eq 'office') {
    $candidates += [PSCustomObject]@{ provider = 'office'; progId = 'PowerPoint.Application' }
  }
  if ($Provider -eq 'auto' -or $Provider -eq 'wps') {
    $candidates += [PSCustomObject]@{ provider = 'wps'; progId = 'kwpp.Application' }
  }
  foreach ($candidate in $candidates) {
    try {
      $application = New-Object -ComObject $candidate.progId
      return [PSCustomObject]@{
        application = $application
        provider = $candidate.provider
        progId = $candidate.progId
      }
    } catch {
      continue
    }
  }
  Throw-Coded 'NO_OFFICE_PROVIDER' '未检测到可用的 Microsoft PowerPoint 或 WPS 演示 COM 自动化接口'
}

function Get-Slide($Presentation, [int]$Index) {
  if ($Index -lt 1 -or $Index -gt $Presentation.Slides.Count) {
    Throw-Coded 'SLIDE_OUT_OF_RANGE' ('幻灯片索引超出范围：' + $Index)
  }
  return $Presentation.Slides.Item($Index)
}

function Get-SlideLayout([string]$Layout) {
  $layouts = @{ title = 1; title_content = 2; section = 33; two_content = 3; blank = 12 }
  if ($layouts.ContainsKey($Layout)) { return $layouts[$Layout] }
  return 2
}

function Read-ShapeText($Shape) {
  try {
    if (-not $Shape.HasTextFrame) { return $null }
    if (-not $Shape.TextFrame.HasText) { return '' }
    return [string]$Shape.TextFrame.TextRange.Text
  } catch {
    return $null
  }
}

function Read-SlideNotes($Slide) {
  try {
    foreach ($shape in $Slide.NotesPage.Shapes) {
      if ($shape.PlaceholderFormat.Type -eq 2) {
        $text = Read-ShapeText $shape
        if ($null -ne $text) { return $text }
      }
    }
  } catch { }
  return ''
}

function Read-Presentation($Presentation, $Request, [string]$Provider, [string]$ProgId) {
  $maxChars = [int]$Request.maxChars
  $remaining = $maxChars
  $truncated = $false
  $slides = @()
  $slideCount = [int]$Presentation.Slides.Count
  for ($index = 1; $index -le $slideCount; $index++) {
    if ($remaining -le 0) { $truncated = $true; break }
    $slide = $Presentation.Slides.Item($index)
    $shapes = @()
    $shapeCount = [int]$slide.Shapes.Count
    for ($shapeIndex = 1; $shapeIndex -le $shapeCount; $shapeIndex++) {
      if ($remaining -le 0) { $truncated = $true; break }
      $shape = $slide.Shapes.Item($shapeIndex)
      $text = Read-ShapeText $shape
      if ($null -eq $text) { continue }
      if ($text.Length -gt $remaining) {
        $text = $text.Substring(0, $remaining)
        $truncated = $true
      }
      $remaining -= $text.Length
      $shapes += [PSCustomObject]@{
        index = $shapeIndex
        name = [string]$shape.Name
        text = $text
      }
    }
    $notes = Read-SlideNotes $slide
    if ($notes.Length -gt 2000) { $notes = $notes.Substring(0, 2000) }
    $slides += [PSCustomObject]@{
      index = $index
      shapeCount = $shapeCount
      shapes = $shapes
      notes = $notes
    }
  }
  return [PSCustomObject]@{
    provider = $Provider
    progId = $ProgId
    slideCount = $slideCount
    truncated = $truncated
    slides = $slides
  }
}

function Set-ShapeTextFormat($Shape, $Operation) {
  $range = $Shape.TextFrame.TextRange
  if (Has-Property $Operation 'bold') { $range.Font.Bold = $(if ([bool]$Operation.bold) { -1 } else { 0 }) }
  if (Has-Property $Operation 'italic') { $range.Font.Italic = $(if ([bool]$Operation.italic) { -1 } else { 0 }) }
  if (Has-Property $Operation 'fontName') { $range.Font.Name = [string]$Operation.fontName }
  if (Has-Property $Operation 'fontSize') { $range.Font.Size = [double]$Operation.fontSize }
  if (Has-Property $Operation 'color') { $range.Font.Color.RGB = Convert-Color ([string]$Operation.color) }
  if (Has-Property $Operation 'alignment') {
    $alignments = @{ left = 1; center = 2; right = 3; justify = 4 }
    $range.ParagraphFormat.Alignment = $alignments[[string]$Operation.alignment]
  }
}

function Set-PlaceholderText($Slide, [int]$Placeholder, [string]$Text) {
  if ($Slide.Shapes.Placeholders.Count -lt $Placeholder) { return $false }
  $shape = $Slide.Shapes.Placeholders.Item($Placeholder)
  $shape.TextFrame.TextRange.Text = $Text
  return $true
}

function Apply-PowerPointOperation($Presentation, $Operation, [System.Collections.ArrayList]$Exports) {
  switch ([string]$Operation.type) {
    'add_slide' {
      $index = $(if (Has-Property $Operation 'index') { [int]$Operation.index } else { [int]$Presentation.Slides.Count + 1 })
      $layout = Get-SlideLayout ([string]$Operation.layout)
      $slide = $Presentation.Slides.Add($index, $layout)
      if (Has-Property $Operation 'title') {
        $null = Set-PlaceholderText $slide 1 ([string]$Operation.title)
      }
      if (Has-Property $Operation 'body') {
        $null = Set-PlaceholderText $slide 2 ([string]$Operation.body)
      }
      if (Has-Property $Operation 'notes') {
        $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = [string]$Operation.notes
      }
    }
    'delete_slide' {
      (Get-Slide $Presentation ([int]$Operation.slide)).Delete()
    }
    'set_text' {
      $slide = Get-Slide $Presentation ([int]$Operation.slide)
      if ([int]$Operation.shape -lt 1 -or [int]$Operation.shape -gt $slide.Shapes.Count) {
        Throw-Coded 'SHAPE_OUT_OF_RANGE' ('形状索引超出范围：' + [string]$Operation.shape)
      }
      $shape = $slide.Shapes.Item([int]$Operation.shape)
      if (-not $shape.HasTextFrame) {
        Throw-Coded 'INVALID_ARGUMENT' ('该形状不含文本框：' + [string]$Operation.shape)
      }
      $shape.TextFrame.TextRange.Text = [string]$Operation.text
      Set-ShapeTextFormat $shape $Operation
    }
    'add_textbox' {
      $slide = Get-Slide $Presentation ([int]$Operation.slide)
      $shape = $slide.Shapes.AddTextbox(1, [double]$Operation.left, [double]$Operation.top, [double]$Operation.widthPoints, [double]$Operation.heightPoints)
      $shape.TextFrame.TextRange.Text = [string]$Operation.text
      Set-ShapeTextFormat $shape $Operation
    }
    'replace_text' {
      $slideCount = [int]$Presentation.Slides.Count
      for ($slideIndex = 1; $slideIndex -le $slideCount; $slideIndex++) {
        $slide = $Presentation.Slides.Item($slideIndex)
        foreach ($shape in $slide.Shapes) {
          if (-not $shape.HasTextFrame) { continue }
          if (-not $shape.TextFrame.HasText) { continue }
          $range = $shape.TextFrame.TextRange
          $found = $range.Replace([string]$Operation.find, [string]$Operation.replace, 0, [bool]$Operation.matchCase, $false)
          while ($null -ne $found) {
            $found = $range.Replace([string]$Operation.find, [string]$Operation.replace, 0, [bool]$Operation.matchCase, $false)
          }
        }
      }
    }
    'set_notes' {
      $slide = Get-Slide $Presentation ([int]$Operation.slide)
      $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = [string]$Operation.text
    }
    'insert_image' {
      $slide = Get-Slide $Presentation ([int]$Operation.slide)
      $width = $(if (Has-Property $Operation 'widthPoints') { [double]$Operation.widthPoints } else { -1 })
      $height = $(if (Has-Property $Operation 'heightPoints') { [double]$Operation.heightPoints } else { -1 })
      $left = $(if (Has-Property $Operation 'left') { [double]$Operation.left } else { 0 })
      $top = $(if (Has-Property $Operation 'top') { [double]$Operation.top } else { 0 })
      $null = $slide.Shapes.AddPicture([string]$Operation.imagePath, $false, $true, $left, $top, $width, $height)
    }
    'export_pdf' {
      $null = $Exports.Add([string]$Operation.outputPath)
    }
    default {
      Throw-Coded 'INVALID_ARGUMENT' ('不支持的 PowerPoint 操作：' + [string]$Operation.type)
    }
  }
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $resolved = New-PowerPointApplication ([string]$request.provider)
  $application = $resolved.application
  $presentation = $null
  try {
    try { $application.DisplayAlerts = 1 } catch { }
    try { $application.AutomationSecurity = 3 } catch { }
    if ([string]$request.action -eq 'read_ppt') {
      $presentation = $application.Presentations.Open([string]$request.path, $true, $false, $false)
      Write-Success (Read-Presentation $presentation $request $resolved.provider $resolved.progId)
    } else {
      if ([bool]$request.create) {
        $presentation = $application.Presentations.Add($false)
      } else {
        $presentation = $application.Presentations.Open([string]$request.path, $false, $false, $false)
      }
      $exports = New-Object System.Collections.ArrayList
      $applied = 0
      foreach ($operation in @($request.operations)) {
        Apply-PowerPointOperation $presentation $operation $exports
        $applied++
      }
      if ([bool]$request.create) {
        $presentation.SaveAs([string]$request.workPath)
      } else {
        $presentation.Save()
      }
      foreach ($outputPath in $exports) {
        $presentation.ExportAsFixedFormat([string]$outputPath, 2)
      }
      Write-Success ([PSCustomObject]@{
        provider = $resolved.provider
        progId = $resolved.progId
        created = [bool]$request.create
        operationsApplied = $applied
      })
    }
  } finally {
    if ($null -ne $presentation) {
      try { $presentation.Close() } catch { }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) } catch { }
    }
    if ($null -ne $application) {
      try { $application.Quit() } catch { }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) } catch { }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
} catch {
  $message = [string]$_.Exception.Message
  $code = 'OFFICE_AUTOMATION_FAILED'
  $separator = $message.IndexOf('|')
  if ($separator -gt 0) {
    $code = $message.Substring(0, $separator)
    $message = $message.Substring($separator + 1)
  }
  Write-Failure $code $message
}
`;

void main().catch(async (error: unknown) => {
  console.error(`[山东梯智物联AI 本机助手] ${error instanceof Error ? error.message : String(error)}`);
  await pauseBeforeWindowsExit();
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const protocolInvocation = rawArgs.some((arg) => /^dsh-local-workspace:/iu.test(arg));
  let options: CliOptions;
  try {
    options = parseArgs(rawArgs);
  } finally {
    if (protocolInvocation) {
      // The browser necessarily passes the short-lived ticket in argv. Drop our
      // references to the complete URI immediately so diagnostics cannot print it.
      rawArgs.fill('');
      process.argv.splice(2, process.argv.length - 2, '[dsh-local-workspace-link]');
    }
  }
  if (options.help) {
    printHelp();
    return;
  }
  if (isWindowsRuntime()) {
    await ensureWindowsProtocolRegistration();
  }
  if (options.launchTicket !== undefined) {
    if (!isWindowsRuntime()) throw new Error('网页一键连接只支持 Windows 本机助手');
    const folder = await chooseWindowsFolder();
    if (folder === null) {
      console.log('[dsh-local-workspace] 已取消选择文件夹。');
      return;
    }
    options = { ...options, folder };
  }
  if (options.setup || process.env.DSH_LOCAL_WORKSPACE_FORCE_WIZARD === '1') {
    options = await runFirstPairingWizard(options);
  }
  if (rawArgs.length === 0 && !options.setup && process.env.DSH_LOCAL_WORKSPACE_FORCE_WIZARD !== '1') {
    const storedConfigs = await storedConfigPaths(options.configPath);
    if (storedConfigs.length > 0) {
      await runStoredConfigs(storedConfigs);
      return;
    }
    if (isWindowsRuntime()) {
      console.log('[dsh-local-workspace] 网页一键选择已安装。');
      console.log('[dsh-local-workspace] 请返回已登录的 dsh 网页，点击“选择本机文件夹”。');
      console.log('[dsh-local-workspace] 如需手动配置，请使用 --setup。');
      await waitAfterWindowsInstallation();
      return;
    }
    options = await runFirstPairingWizard(options);
  }
  const initial = await resolveConfig(options);
  const running = runForever(initial, options.configPath, options.pairCode, options.launchTicket);
  options.launchTicket = undefined;
  options.launchWorkspaceId = undefined;
  await running;
}

async function runStoredConfigs(configPaths: string[]): Promise<void> {
  await Promise.all(configPaths.map(async (configPath) => {
    try {
      const options = defaultCliOptions(configPath);
      const config = await resolveConfig(options);
      await runForever(config, configPath);
    } catch (error) {
      console.error(`[dsh-local-workspace] 已保存的本机工作区启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

async function runForever(
  config: CompanionConfig,
  configPath: string,
  pairCode?: string,
  launchTicket?: string,
): Promise<never> {
  let delayMs = 1_000;
  let firstPairCode = pairCode;
  let firstLaunchTicket = launchTicket;
  launchTicket = undefined;
  for (;;) {
    try {
      await runConnection(config, configPath, firstPairCode, firstLaunchTicket, () => {
        firstPairCode = undefined;
        firstLaunchTicket = undefined;
      });
      delayMs = 1_000;
    } catch (error) {
      console.error(`[dsh-local-workspace] ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof CompanionError && (error.code === 'AUTH_FAILED' || error.code === 'LAUNCH_FAILED')) {
        throw error;
      }
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
    console.log('[dsh-local-workspace] 正在重新连接…');
  }
}

function runConnection(
  config: CompanionConfig,
  configPath: string,
  pairCode?: string,
  launchTicket?: string,
  onAuthenticated: () => void = () => undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(config.server, { maxPayload: LOCAL_WORKSPACE_MAX_MESSAGE_BYTES });
    const running = new Map<string, RunningOperation>();
    const handshakeMode: 'device' | 'launch' | 'pair' | 'resume' =
      launchTicket !== undefined
        ? 'launch'
        : pairCode !== undefined
          ? 'pair'
          : config.token !== undefined
            ? 'resume'
            : 'device';
    let authenticated = false;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const operation of running.values()) operation.controller.abort();
      running.clear();
      if (error === undefined) resolve();
      else reject(error);
    };

    socket.once('open', () => {
      const shared = {
        protocol: LOCAL_WORKSPACE_PROTOCOL_VERSION,
        deviceName: config.deviceName,
        workspaceName: config.workspaceName,
        workspaceId: config.workspaceId,
        root: config.root,
        platform: isWindowsRuntime() ? 'win32' : process.platform,
        shellEnabled: config.shellEnabled,
        desktopControl: config.desktopControl,
      } as const;
      if (launchTicket !== undefined) {
        socket.send(JSON.stringify({ type: 'launch', ticket: launchTicket, ...shared }));
      } else if (pairCode !== undefined) {
        socket.send(JSON.stringify({ type: 'pair', code: pairCode, ...shared }));
      } else if (config.token !== undefined) {
        socket.send(JSON.stringify({ type: 'resume', token: config.token, ...shared }));
      } else {
        socket.send(JSON.stringify({ type: 'device', ...shared }));
      }
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text frames only');
        return;
      }
      void handleMessage(data.toString('utf8')).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        finish(failure);
        socket.close(1002, 'message handling failed');
      });
    });

    socket.on('error', (error) => finish(error));
    socket.on('close', (code, reason) => {
      const text = reason.toString('utf8');
      if (!authenticated && code === 1008) {
        if (handshakeMode === 'launch') {
          finish(new CompanionError('网页一键连接凭据无效或已过期', 'LAUNCH_FAILED'));
          return;
        }
        finish(new CompanionError(
          text || (handshakeMode === 'device' ? '设备确认失败或已过期' : '配对或设备令牌无效'),
          handshakeMode === 'device' ? 'DEVICE_APPROVAL_FAILED' : 'AUTH_FAILED',
        ));
      } else if (handshakeMode === 'launch' && text !== '') {
        // A launch close reason is controlled by the remote endpoint. Never
        // allow it to reflect the short-lived bearer ticket into local logs.
        finish(new Error('网页一键连接已中断'));
      } else {
        finish(text === '' ? undefined : new Error(`连接关闭：${text}`));
      }
    });

    async function handleMessage(raw: string): Promise<void> {
      const value = parseWireObject(raw);
      if (value.type === 'device-code') {
        if (handshakeMode !== 'device' || authenticated) {
          throw new CompanionError('服务器在错误的连接阶段发送了设备确认码', 'PROTOCOL_ERROR');
        }
        const code = parseDisplayedDeviceCode(value.code);
        const expiresAt = parseDeviceCodeExpiry(value.expiresAt);
        printDeviceApproval(code, expiresAt);
        return;
      }
      if (value.type === 'ready') {
        const token = parseDeviceToken(value.token);
        if (value.token !== undefined && token === undefined) {
          throw new CompanionError('服务器签发的设备令牌格式无效', 'PROTOCOL_ERROR');
        }
        if (handshakeMode !== 'resume' && token === undefined) {
          throw new CompanionError('首次配对成功但服务器未签发设备令牌', 'PROTOCOL_ERROR');
        }
        authenticated = true;
        if (token !== undefined) {
          config.token = token;
          await saveConfig(configPath, config);
          pairCode = undefined;
          launchTicket = undefined;
        }
        onAuthenticated();
        console.log(`[dsh-local-workspace] 已连接：${config.workspaceName}`);
        console.log(`[dsh-local-workspace] 授权目录：${config.root}`);
        console.log(`[dsh-local-workspace] Shell：${config.shellEnabled ? '已启用（可访问当前系统用户权限范围）' : '已关闭'}`);
        console.log(`[dsh-local-workspace] 桌面控制：${config.desktopControl ? '已启用（可截屏并操作鼠标键盘）' : '已关闭'}`);
        return;
      }
      if (value.type === 'error') {
        if (!authenticated && handshakeMode === 'launch') {
          throw new CompanionError('网页一键连接凭据无效或已过期', 'LAUNCH_FAILED');
        }
        const message = typeof value.error === 'string' ? value.error : '服务器拒绝连接';
        const code = typeof value.code === 'string' ? value.code : 'PROTOCOL_ERROR';
        throw new CompanionError(message, code);
      }
      if (!authenticated) throw new Error('received operation before authentication');
      if (value.type === 'cancel') {
        const id = requireString(value.id, 'id', 1, 120);
        running.get(id)?.controller.abort();
        return;
      }
      if (value.type !== 'request') throw new Error('unsupported host message');
      const request = parseRequest(value);
      if (running.has(request.id)) throw new Error(`duplicate operation id ${request.id}`);
      const controller = new AbortController();
      running.set(request.id, { controller });
      try {
        const result = await executeOperation(config, request.operation, request.args, controller.signal);
        send({ type: 'response', id: request.id, ok: true, value: result });
      } catch (error) {
        const aborted = controller.signal.aborted;
        send({
          type: 'response',
          id: request.id,
          ok: false,
          code: aborted ? 'ABORTED' : error instanceof CompanionError ? error.code : 'OPERATION_FAILED',
          error: aborted ? 'operation aborted' : error instanceof Error ? error.message : String(error),
        });
      } finally {
        running.delete(request.id);
      }
    }

    function send(message: LocalWorkspaceResponse): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  });
}

/**
 * Run one companion operation against the authorized folder or, for the desktop
 * operations, this computer's own screen and input devices.
 * @param config - the resolved companion configuration, carrying both grants.
 * @param operation - the requested operation.
 * @param args - the operation's arguments as received from the host.
 * @param signal - cancellation for the operation.
 * @returns the operation's result value.
 * @throws CompanionError when the grant is absent or the operation fails.
 */
export async function executeOperation(
  config: CompanionConfig,
  operation: LocalWorkspaceOperation,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  switch (operation) {
    case 'files':
      return await browseLocalWorkspace(config.root, args, signal);
    case 'read':
      return await readTextWindow(config.root, args, signal);
    case 'write':
      return await writeTextFile(config.root, args, signal);
    case 'edit':
      return await editTextFile(config.root, args, signal);
    case 'glob':
      return await globFiles(config.root, args, signal);
    case 'grep':
      return await grepFiles(config.root, args, signal);
    case 'bash':
      if (!config.shellEnabled) throw new CompanionError('本机助手未启用 Shell；重新配对时添加 --allow-shell', 'SHELL_DISABLED');
      return await runShell(config.root, args, signal);
    case 'office':
      return await runOfficeOperation(config.root, args, signal);
    case 'screenshot':
      return await captureDesktopScreen(config, args, signal);
    case 'input':
      return await sendDesktopInput(config, args, signal);
  }
}

async function readTextWindow(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const relative = requireRelativePath(args.path, 'path');
  const offset = optionalPositiveInteger(args.offset, 'offset') ?? 1;
  const limit = optionalPositiveInteger(args.limit, 'limit') ?? 500;
  if (limit > 2_000) throw new CompanionError('limit 不能超过 2000', 'INVALID_ARGUMENT');
  const target = await existingPathWithin(root, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new CompanionError('目标不是普通文件', 'NOT_FILE');
  if (info.size > MAX_TEXT_BYTES) throw new CompanionError('文本文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  throwIfAborted(signal);
  const content = await readFile(target, 'utf8');
  throwIfAborted(signal);
  const lines = content.split(/\r?\n/);
  const start = Math.min(offset - 1, lines.length);
  return {
    path: displayPath(relative),
    offset,
    lines: lines.slice(start, start + limit).map((text, index) => ({ number: start + index + 1, text })),
    totalLines: lines.length,
  };
}

async function writeTextFile(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const relative = requireRelativePath(args.path, 'path');
  const content = requireString(args.content, 'content', 0, MAX_TEXT_BYTES);
  const target = await writablePathWithin(root, relative);
  let before: string | null = null;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new CompanionError('目标不是普通文件', 'NOT_FILE');
    if (info.size > MAX_TEXT_BYTES) throw new CompanionError('原文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
    before = await readFile(target, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throwIfAborted(signal);
  await atomicWrite(target, content);
  throwIfAborted(signal);
  return { path: displayPath(relative), operation: before === null ? 'create' : 'update', before, after: content };
}

async function editTextFile(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const relative = requireRelativePath(args.path, 'path');
  const oldString = requireString(args.oldString, 'oldString', 1, MAX_TEXT_BYTES);
  const newString = requireString(args.newString, 'newString', 0, MAX_TEXT_BYTES);
  const replaceAll = args.replaceAll === true;
  const target = await existingPathWithin(root, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new CompanionError('目标不是普通文件', 'NOT_FILE');
  if (info.size > MAX_TEXT_BYTES) throw new CompanionError('文本文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  const before = await readFile(target, 'utf8');
  throwIfAborted(signal);
  // `read` splits on /\r?\n/, so a caller quoting several lines back sends them
  // LF-joined even when the file on disk keeps CRLF. Matching the raw text then
  // fails on every multi-line edit of a Windows checkout. Try the text as sent,
  // then as the file spells its line endings, and write the replacement in that
  // same spelling so one edit never leaves the file with mixed endings.
  const crlf = before.includes('\r\n');
  const toFileEol = (value: string): string => (crlf ? value.replace(/\r?\n/g, '\r\n') : value);
  let needle = oldString;
  let count = countOccurrences(before, needle);
  if (count === 0 && crlf) {
    needle = toFileEol(oldString);
    count = countOccurrences(before, needle);
  }
  if (count === 0) throw new CompanionError('old_string 未在文件中出现', 'NO_MATCH');
  if (!replaceAll && count !== 1) throw new CompanionError(`old_string 出现 ${String(count)} 次，请提供更具体内容或设置 replace_all`, 'MULTIPLE_MATCHES');
  const replacement = toFileEol(newString);
  const after = replaceAll ? before.split(needle).join(replacement) : before.replace(needle, replacement);
  if (Buffer.byteLength(after, 'utf8') > MAX_TEXT_BYTES) throw new CompanionError('编辑后文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  await atomicWrite(target, after);
  throwIfAborted(signal);
  return { path: displayPath(relative), before, after, replacements: replaceAll ? count : 1 };
}

async function globFiles(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const pattern = requireString(args.pattern, 'pattern', 1, 500).replace(/\\/g, '/');
  const relativeRoot = optionalRelativePath(args.path, 'path') ?? '.';
  const searchRoot = await existingPathWithin(root, relativeRoot);
  if (!(await stat(searchRoot)).isDirectory()) throw new CompanionError('glob path 不是目录', 'NOT_DIRECTORY');
  const matcher = globRegex(pattern);
  const files = await walkFiles(root, searchRoot, signal);
  const paths = files
    .map((file) => path.relative(searchRoot, file).split(path.sep).join('/'))
    .filter((file) => matcher.test(file))
    .slice(0, MAX_SEARCH_RESULTS);
  return { root: displayPath(relativeRoot), paths };
}

async function grepFiles(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const source = requireString(args.pattern, 'pattern', 1, 2_000);
  const relativeRoot = optionalRelativePath(args.path, 'path') ?? '.';
  const include = typeof args.include === 'string' && args.include !== '' ? globRegex(args.include) : null;
  let expression: RegExp;
  try {
    expression = new RegExp(source, 'u');
  } catch (error) {
    throw new CompanionError(`无效正则表达式：${error instanceof Error ? error.message : String(error)}`, 'INVALID_REGEX');
  }
  const target = await existingPathWithin(root, relativeRoot);
  const info = await stat(target);
  const files = info.isFile() ? [target] : await walkFiles(root, target, signal);
  const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
  for (const file of files) {
    throwIfAborted(signal);
    const relative = path.relative(target, file).split(path.sep).join('/') || path.basename(file);
    if (include !== null && !include.test(relative)) continue;
    const fileInfo = await stat(file);
    if (fileInfo.size > MAX_TEXT_BYTES) continue;
    const content = await readFile(file);
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      expression.lastIndex = 0;
      if (expression.test(line)) matches.push({ path: relative, lineNumber: index + 1, line: line.slice(0, 2_000) });
      if (matches.length >= MAX_SEARCH_RESULTS) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

async function runShell(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const command = requireString(args.command, 'command', 1, 200_000);
  const relativeWorkdir = optionalRelativePath(args.workdir, 'workdir') ?? '.';
  const workdir = await existingPathWithin(root, relativeWorkdir);
  if (!(await stat(workdir)).isDirectory()) throw new CompanionError('workdir 不是目录', 'NOT_DIRECTORY');
  const timeoutMs = Math.min(optionalPositiveInteger(args.timeoutMs, 'timeoutMs') ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  return await spawnCommand(command, workdir, timeoutMs, signal);
}

type OfficeProvider = 'auto' | 'office' | 'wps';

interface PowerShellEnvelope {
  ok: boolean;
  value?: unknown;
  code?: string;
  error?: string;
}

/** One automated Office application: which files it accepts and how a batch edit is validated. */
interface OfficeApplication {
  readonly label: string;
  readonly readAction: string;
  readonly editAction: string;
  readonly script: string;
  readonly extensions: readonly string[];
  readonly normalizeOperations: (root: string, value: unknown) => Promise<Array<Record<string, unknown>>>;
  /** Extra read arguments, resolved from the request after the path is validated. */
  readonly readArguments: (args: Record<string, unknown>) => Record<string, unknown>;
}

const OFFICE_APPLICATIONS: readonly OfficeApplication[] = [
  {
    label: 'Word',
    readAction: 'read_word',
    editAction: 'edit_word',
    script: WINDOWS_WORD_AUTOMATION_SCRIPT,
    extensions: ['.docx', '.docm', '.doc', '.rtf', '.odt'],
    normalizeOperations: normalizeWordOperations,
    readArguments: (args) => ({
      maxChars: Math.min(optionalPositiveInteger(args.maxChars, 'maxChars') ?? 50_000, MAX_OFFICE_TEXT_CHARS),
    }),
  },
  {
    label: 'Excel',
    readAction: 'read_excel',
    editAction: 'edit_excel',
    script: WINDOWS_EXCEL_AUTOMATION_SCRIPT,
    extensions: ['.xlsx', '.xlsm', '.xls', '.csv', '.ods'],
    normalizeOperations: normalizeExcelOperations,
    readArguments: (args) => ({
      maxCells: Math.min(optionalPositiveInteger(args.maxCells, 'maxCells') ?? 5_000, MAX_OFFICE_CELLS),
      ...(args.sheet === undefined ? {} : { sheet: sheetSelector(args.sheet) }),
    }),
  },
  {
    label: 'PowerPoint',
    readAction: 'read_ppt',
    editAction: 'edit_ppt',
    script: WINDOWS_POWERPOINT_AUTOMATION_SCRIPT,
    extensions: ['.pptx', '.pptm', '.ppt', '.odp'],
    normalizeOperations: normalizePowerPointOperations,
    readArguments: (args) => ({
      maxChars: Math.min(optionalPositiveInteger(args.maxChars, 'maxChars') ?? 50_000, MAX_OFFICE_TEXT_CHARS),
    }),
  },
];

const OFFICE_ACTIONS = [
  'status',
  ...OFFICE_APPLICATIONS.flatMap((application) => [application.readAction, application.editAction]),
] as const;

async function runOfficeOperation(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const action = requireEnum(args.action, 'action', OFFICE_ACTIONS);
  const provider = args.provider === undefined
    ? 'auto'
    : requireEnum(args.provider, 'provider', ['auto', 'office', 'wps'] as const);
  if (!isWindowsRuntime()) throw new CompanionError('原生 Office/WPS 自动化只支持 Windows 本机助手', 'WINDOWS_ONLY');
  if (action === 'status') {
    return await runOfficePowerShell(WINDOWS_OFFICE_STATUS_SCRIPT, { action, provider }, root, DEFAULT_OFFICE_TIMEOUT_MS, signal);
  }
  const application = OFFICE_APPLICATIONS.find(
    (candidate) => candidate.readAction === action || candidate.editAction === action,
  );
  if (application === undefined) throw new CompanionError(`未实现的 Office 操作：${action}`, 'INVALID_ARGUMENT');

  const relative = requireRelativePath(args.path, 'path');
  assertOfficeExtension(application, relative);
  if (action === application.readAction) {
    const target = await existingPathWithin(root, relative);
    if (!(await stat(target)).isFile()) {
      throw new CompanionError(`${application.label} 路径不是普通文件`, 'NOT_FILE');
    }
    const result = await runOfficePowerShell(application.script, {
      action,
      provider,
      path: target,
      ...application.readArguments(args),
    }, path.dirname(target), DEFAULT_OFFICE_TIMEOUT_MS, signal);
    return { ...(requireObject(result, 'Office 返回值无效')), path: displayPath(relative) };
  }

  const create = args.create === true;
  const overwrite = args.overwrite === true;
  const target = create ? await writablePathWithin(root, relative) : await existingPathWithin(root, relative);
  if (!create && !(await stat(target)).isFile()) {
    throw new CompanionError(`${application.label} 路径不是普通文件`, 'NOT_FILE');
  }
  if (create) {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new CompanionError(`${application.label} 路径不是普通文件`, 'NOT_FILE');
      if (!overwrite) {
        throw new CompanionError(`目标 ${application.label} 文档已存在；如需覆盖请设置 overwrite`, 'FILE_EXISTS');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const operations = await application.normalizeOperations(root, args.operations);
  const timeoutMs = Math.min(optionalPositiveInteger(args.timeoutMs, 'timeoutMs') ?? DEFAULT_OFFICE_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const temporary = create ? temporaryOfficePath(target) : undefined;
  try {
    const result = await runOfficePowerShell(application.script, {
      action,
      provider,
      path: target,
      workPath: temporary ?? target,
      create,
      operations,
    }, path.dirname(target), timeoutMs, signal);
    if (temporary !== undefined) await rename(temporary, target);
    const value = requireObject(result, 'Office 返回值无效');
    return {
      ...value,
      path: displayPath(relative),
      pdfPaths: operations
        .filter((operation) => operation.type === 'export_pdf')
        .map((operation) => displayPath(path.relative(root, String(operation.outputPath)))),
    };
  } finally {
    if (temporary !== undefined) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissing(error)) {
          console.warn(`[dsh-local-workspace] ${application.label} 临时文件清理失败：${String(error)}`);
        }
      }
    }
  }
}

async function normalizeWordOperations(root: string, value: unknown): Promise<Array<Record<string, unknown>>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OFFICE_OPERATIONS) {
    throw new CompanionError(`operations 必须包含 1-${String(MAX_OFFICE_OPERATIONS)} 项`, 'INVALID_ARGUMENT');
  }
  const normalized: Array<Record<string, unknown>> = [];
  for (const raw of value) {
    const operation = requireObject(raw, 'Word 操作必须是对象');
    const type = requireEnum(operation.type, 'operation.type', [
      'replace_text',
      'append_paragraph',
      'insert_paragraph',
      'set_paragraph',
      'delete_paragraph',
      'add_table',
      'set_header',
      'set_footer',
      'insert_image',
      'page_break',
      'export_pdf',
    ] as const);
    switch (type) {
      case 'replace_text':
        normalized.push({
          type,
          find: requireString(operation.find, 'find', 1, MAX_OFFICE_TEXT_CHARS),
          replace: requireString(operation.replace, 'replace', 0, MAX_OFFICE_TEXT_CHARS),
          replaceAll: operation.replaceAll !== false,
          matchCase: operation.matchCase === true,
          wholeWord: operation.wholeWord === true,
        });
        break;
      case 'append_paragraph':
        normalized.push({ type, text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS), ...wordFormat(operation) });
        break;
      case 'insert_paragraph':
        normalized.push({
          type,
          paragraph: requiredPositiveInteger(operation.paragraph, 'paragraph'),
          text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS),
          ...wordFormat(operation),
        });
        break;
      case 'set_paragraph': {
        const format = wordFormat(operation);
        if (operation.text === undefined && Object.keys(format).length === 0) {
          throw new CompanionError('set_paragraph 至少需要 text 或一个格式字段', 'INVALID_ARGUMENT');
        }
        normalized.push({
          type,
          paragraph: requiredPositiveInteger(operation.paragraph, 'paragraph'),
          ...(operation.text === undefined ? {} : { text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS) }),
          ...format,
        });
        break;
      }
      case 'delete_paragraph':
        normalized.push({ type, paragraph: requiredPositiveInteger(operation.paragraph, 'paragraph') });
        break;
      case 'add_table':
        normalized.push({
          type,
          rows: wordTableRows(operation.rows),
          ...(operation.afterParagraph === undefined ? {} : { afterParagraph: requiredPositiveInteger(operation.afterParagraph, 'afterParagraph') }),
          header: operation.header === true,
          ...(operation.style === undefined ? {} : { style: requireString(operation.style, 'style', 1, 120) }),
        });
        break;
      case 'set_header':
      case 'set_footer':
        normalized.push({ type, text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS) });
        break;
      case 'insert_image': {
        const imageRelative = requireRelativePath(operation.imagePath, 'imagePath');
        const imagePath = await existingPathWithin(root, imageRelative);
        if (!(await stat(imagePath)).isFile()) throw new CompanionError('图片路径不是普通文件', 'NOT_FILE');
        normalized.push({
          type,
          imagePath,
          ...(operation.paragraph === undefined ? {} : { paragraph: requiredPositiveInteger(operation.paragraph, 'paragraph') }),
          ...(operation.widthPoints === undefined ? {} : { widthPoints: boundedNumber(operation.widthPoints, 'widthPoints', 1, 2_000) }),
          ...(operation.heightPoints === undefined ? {} : { heightPoints: boundedNumber(operation.heightPoints, 'heightPoints', 1, 2_000) }),
        });
        break;
      }
      case 'page_break':
        normalized.push({
          type,
          ...(operation.paragraph === undefined ? {} : { paragraph: requiredPositiveInteger(operation.paragraph, 'paragraph') }),
        });
        break;
      case 'export_pdf':
        normalized.push({ type, outputPath: await exportPdfPath(root, operation.outputPath) });
        break;
    }
  }
  assertOfficeOperationsSize(normalized, 'Word');
  return normalized;
}

/** Accept a worksheet name or a 1-based index, the two forms Get-Worksheet resolves. */
function sheetSelector(value: unknown): string | number {
  if (typeof value === 'number') return requiredPositiveInteger(value, 'sheet');
  return requireString(value, 'sheet', 1, 120);
}

/** Optional worksheet selector, spread into a normalized operation. */
function sheetField(operation: Record<string, unknown>): Record<string, unknown> {
  return operation.sheet === undefined ? {} : { sheet: sheetSelector(operation.sheet) };
}

/** Validate an A1-style reference before PowerShell hands it to Range(). */
function requireRangeReference(value: unknown, name: string): string {
  const reference = requireString(value, name, 1, 120);
  if (!/^[A-Za-z$]{1,3}[0-9$]{0,7}(:[A-Za-z$]{1,3}[0-9$]{0,7})?$/.test(reference)) {
    throw new CompanionError(`${name} 必须是 A1、A1:C10 或 A:C 这类区域引用`, 'INVALID_ARGUMENT');
  }
  return reference;
}

/** A rectangular block of cell text; a leading `=` is written as a formula. */
function excelRows(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OFFICE_ROWS) {
    throw new CompanionError(`rows 必须包含 1-${String(MAX_OFFICE_ROWS)} 行`, 'INVALID_ARGUMENT');
  }
  let cells = 0;
  return value.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow) || rawRow.length < 1 || rawRow.length > MAX_OFFICE_COLUMNS) {
      throw new CompanionError(`rows[${String(rowIndex)}] 必须包含 1-${String(MAX_OFFICE_COLUMNS)} 列`, 'INVALID_ARGUMENT');
    }
    cells += rawRow.length;
    if (cells > MAX_OFFICE_CELLS) {
      throw new CompanionError(`单次写入不得超过 ${String(MAX_OFFICE_CELLS)} 个单元格`, 'REQUEST_TOO_LARGE');
    }
    return rawRow.map((cell, columnIndex) => requireString(cell, `rows[${String(rowIndex)}][${String(columnIndex)}]`, 0, 32_767));
  });
}

/** Font and fill fields shared by Excel range formatting. */
function excelFormat(operation: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(operation.bold === undefined ? {} : { bold: requireBoolean(operation.bold, 'bold') }),
    ...(operation.italic === undefined ? {} : { italic: requireBoolean(operation.italic, 'italic') }),
    ...(operation.fontName === undefined ? {} : { fontName: requireString(operation.fontName, 'fontName', 1, 120) }),
    ...(operation.fontSize === undefined ? {} : { fontSize: boundedNumber(operation.fontSize, 'fontSize', 1, 409) }),
    ...(operation.color === undefined ? {} : { color: requireHexColor(operation.color) }),
    ...(operation.background === undefined ? {} : { background: requireHexColor(operation.background) }),
    ...(operation.numberFormat === undefined ? {} : { numberFormat: requireString(operation.numberFormat, 'numberFormat', 1, 200) }),
    ...(operation.wrap === undefined ? {} : { wrap: requireBoolean(operation.wrap, 'wrap') }),
    ...(operation.merge === undefined ? {} : { merge: requireBoolean(operation.merge, 'merge') }),
    ...(operation.alignment === undefined ? {} : {
      alignment: requireEnum(operation.alignment, 'alignment', ['left', 'center', 'right'] as const),
    }),
  };
}

const EXCEL_OPERATION_TYPES = [
  'set_cells',
  'append_rows',
  'set_formula',
  'clear_range',
  'format_range',
  'set_column_width',
  'set_row_height',
  'autofit',
  'add_sheet',
  'rename_sheet',
  'delete_sheet',
  'replace_text',
  'insert_image',
  'export_pdf',
] as const;

async function normalizeExcelOperations(root: string, value: unknown): Promise<Array<Record<string, unknown>>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OFFICE_OPERATIONS) {
    throw new CompanionError(`operations 必须包含 1-${String(MAX_OFFICE_OPERATIONS)} 项`, 'INVALID_ARGUMENT');
  }
  const normalized: Array<Record<string, unknown>> = [];
  for (const raw of value) {
    const operation = requireObject(raw, 'Excel 操作必须是对象');
    const type = requireEnum(operation.type, 'operation.type', EXCEL_OPERATION_TYPES);
    switch (type) {
      case 'set_cells':
        normalized.push({
          type,
          ...sheetField(operation),
          row: requiredPositiveInteger(operation.row ?? 1, 'row'),
          column: requiredPositiveInteger(operation.column ?? 1, 'column'),
          rows: excelRows(operation.rows),
        });
        break;
      case 'append_rows':
        normalized.push({ type, ...sheetField(operation), rows: excelRows(operation.rows) });
        break;
      case 'set_formula':
        normalized.push({
          type,
          ...sheetField(operation),
          range: requireRangeReference(operation.range, 'range'),
          formula: requireString(operation.formula, 'formula', 1, 8_192),
        });
        break;
      case 'clear_range':
        normalized.push({ type, ...sheetField(operation), range: requireRangeReference(operation.range, 'range') });
        break;
      case 'format_range':
        normalized.push({
          type,
          ...sheetField(operation),
          range: requireRangeReference(operation.range, 'range'),
          ...excelFormat(operation),
        });
        break;
      case 'set_column_width':
        normalized.push({
          type,
          ...sheetField(operation),
          range: requireRangeReference(operation.range, 'range'),
          width: boundedNumber(operation.width, 'width', 0, 255),
        });
        break;
      case 'set_row_height':
        normalized.push({
          type,
          ...sheetField(operation),
          range: requireRangeReference(operation.range, 'range'),
          height: boundedNumber(operation.height, 'height', 0, 409),
        });
        break;
      case 'autofit':
        normalized.push({
          type,
          ...sheetField(operation),
          ...(operation.range === undefined ? {} : { range: requireRangeReference(operation.range, 'range') }),
        });
        break;
      case 'add_sheet':
        normalized.push({
          type,
          ...(operation.name === undefined ? {} : { name: requireString(operation.name, 'name', 1, 31) }),
        });
        break;
      case 'rename_sheet':
        normalized.push({ type, ...sheetField(operation), name: requireString(operation.name, 'name', 1, 31) });
        break;
      case 'delete_sheet':
        normalized.push({ type, sheet: sheetSelector(operation.sheet) });
        break;
      case 'replace_text':
        normalized.push({
          type,
          ...sheetField(operation),
          find: requireString(operation.find, 'find', 1, 32_767),
          replace: requireString(operation.replace, 'replace', 0, 32_767),
          matchCase: operation.matchCase === true,
          wholeCell: operation.wholeCell === true,
        });
        break;
      case 'insert_image': {
        const imageRelative = requireRelativePath(operation.imagePath, 'imagePath');
        const imagePath = await existingPathWithin(root, imageRelative);
        if (!(await stat(imagePath)).isFile()) throw new CompanionError('图片路径不是普通文件', 'NOT_FILE');
        normalized.push({
          type,
          ...sheetField(operation),
          range: requireRangeReference(operation.range ?? 'A1', 'range'),
          imagePath,
          ...(operation.widthPoints === undefined ? {} : { widthPoints: boundedNumber(operation.widthPoints, 'widthPoints', 1, 2_000) }),
          ...(operation.heightPoints === undefined ? {} : { heightPoints: boundedNumber(operation.heightPoints, 'heightPoints', 1, 2_000) }),
        });
        break;
      }
      case 'export_pdf':
        normalized.push({ type, outputPath: await exportPdfPath(root, operation.outputPath) });
        break;
    }
  }
  assertOfficeOperationsSize(normalized, 'Excel');
  return normalized;
}

/** Text and paragraph fields shared by PowerPoint shape operations. */
function powerPointFormat(operation: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(operation.bold === undefined ? {} : { bold: requireBoolean(operation.bold, 'bold') }),
    ...(operation.italic === undefined ? {} : { italic: requireBoolean(operation.italic, 'italic') }),
    ...(operation.fontName === undefined ? {} : { fontName: requireString(operation.fontName, 'fontName', 1, 120) }),
    ...(operation.fontSize === undefined ? {} : { fontSize: boundedNumber(operation.fontSize, 'fontSize', 1, 400) }),
    ...(operation.color === undefined ? {} : { color: requireHexColor(operation.color) }),
    ...(operation.alignment === undefined ? {} : {
      alignment: requireEnum(operation.alignment, 'alignment', ['left', 'center', 'right', 'justify'] as const),
    }),
  };
}

const POWERPOINT_OPERATION_TYPES = [
  'add_slide',
  'delete_slide',
  'set_text',
  'add_textbox',
  'replace_text',
  'set_notes',
  'insert_image',
  'export_pdf',
] as const;

async function normalizePowerPointOperations(root: string, value: unknown): Promise<Array<Record<string, unknown>>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OFFICE_OPERATIONS) {
    throw new CompanionError(`operations 必须包含 1-${String(MAX_OFFICE_OPERATIONS)} 项`, 'INVALID_ARGUMENT');
  }
  const normalized: Array<Record<string, unknown>> = [];
  for (const raw of value) {
    const operation = requireObject(raw, 'PowerPoint 操作必须是对象');
    const type = requireEnum(operation.type, 'operation.type', POWERPOINT_OPERATION_TYPES);
    switch (type) {
      case 'add_slide':
        normalized.push({
          type,
          ...(operation.index === undefined ? {} : { index: requiredPositiveInteger(operation.index, 'index') }),
          layout: operation.layout === undefined
            ? 'title_content'
            : requireEnum(operation.layout, 'layout', ['title', 'title_content', 'two_content', 'section', 'blank'] as const),
          ...(operation.title === undefined ? {} : { title: requireString(operation.title, 'title', 0, MAX_OFFICE_TEXT_CHARS) }),
          ...(operation.body === undefined ? {} : { body: requireString(operation.body, 'body', 0, MAX_OFFICE_TEXT_CHARS) }),
          ...(operation.notes === undefined ? {} : { notes: requireString(operation.notes, 'notes', 0, MAX_OFFICE_TEXT_CHARS) }),
        });
        break;
      case 'delete_slide':
        normalized.push({ type, slide: requiredPositiveInteger(operation.slide, 'slide') });
        break;
      case 'set_text':
        normalized.push({
          type,
          slide: requiredPositiveInteger(operation.slide, 'slide'),
          shape: requiredPositiveInteger(operation.shape, 'shape'),
          text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS),
          ...powerPointFormat(operation),
        });
        break;
      case 'add_textbox':
        normalized.push({
          type,
          slide: requiredPositiveInteger(operation.slide, 'slide'),
          text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS),
          left: boundedNumber(operation.left ?? 50, 'left', 0, 4_000),
          top: boundedNumber(operation.top ?? 50, 'top', 0, 4_000),
          widthPoints: boundedNumber(operation.widthPoints ?? 400, 'widthPoints', 1, 4_000),
          heightPoints: boundedNumber(operation.heightPoints ?? 100, 'heightPoints', 1, 4_000),
          ...powerPointFormat(operation),
        });
        break;
      case 'replace_text':
        normalized.push({
          type,
          find: requireString(operation.find, 'find', 1, MAX_OFFICE_TEXT_CHARS),
          replace: requireString(operation.replace, 'replace', 0, MAX_OFFICE_TEXT_CHARS),
          matchCase: operation.matchCase === true,
        });
        break;
      case 'set_notes':
        normalized.push({
          type,
          slide: requiredPositiveInteger(operation.slide, 'slide'),
          text: requireString(operation.text, 'text', 0, MAX_OFFICE_TEXT_CHARS),
        });
        break;
      case 'insert_image': {
        const imageRelative = requireRelativePath(operation.imagePath, 'imagePath');
        const imagePath = await existingPathWithin(root, imageRelative);
        if (!(await stat(imagePath)).isFile()) throw new CompanionError('图片路径不是普通文件', 'NOT_FILE');
        normalized.push({
          type,
          slide: requiredPositiveInteger(operation.slide, 'slide'),
          imagePath,
          ...(operation.left === undefined ? {} : { left: boundedNumber(operation.left, 'left', 0, 4_000) }),
          ...(operation.top === undefined ? {} : { top: boundedNumber(operation.top, 'top', 0, 4_000) }),
          ...(operation.widthPoints === undefined ? {} : { widthPoints: boundedNumber(operation.widthPoints, 'widthPoints', 1, 4_000) }),
          ...(operation.heightPoints === undefined ? {} : { heightPoints: boundedNumber(operation.heightPoints, 'heightPoints', 1, 4_000) }),
        });
        break;
      }
      case 'export_pdf':
        normalized.push({ type, outputPath: await exportPdfPath(root, operation.outputPath) });
        break;
    }
  }
  assertOfficeOperationsSize(normalized, 'PowerPoint');
  return normalized;
}

/** Resolve and create the directory for one `export_pdf` destination. */
async function exportPdfPath(root: string, value: unknown): Promise<string> {
  const outputRelative = requireRelativePath(value, 'outputPath');
  if (path.extname(outputRelative).toLowerCase() !== '.pdf') {
    throw new CompanionError('outputPath 必须以 .pdf 结尾', 'INVALID_ARGUMENT');
  }
  const outputPath = await writablePathWithin(root, outputRelative);
  await mkdir(path.dirname(outputPath), { recursive: true });
  return outputPath;
}

/** Keep one batch inside the companion's message budget. */
function assertOfficeOperationsSize(normalized: Array<Record<string, unknown>>, label: string): void {
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 2 * 1024 * 1024) {
    throw new CompanionError(`${label} 批量操作超过 2 MiB 上限`, 'REQUEST_TOO_LARGE');
  }
}

function wordFormat(operation: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(operation.style === undefined ? {} : { style: requireString(operation.style, 'style', 1, 120) }),
    ...(operation.alignment === undefined ? {} : {
      alignment: requireEnum(operation.alignment, 'alignment', ['left', 'center', 'right', 'justify'] as const),
    }),
    ...(operation.bold === undefined ? {} : { bold: requireBoolean(operation.bold, 'bold') }),
    ...(operation.italic === undefined ? {} : { italic: requireBoolean(operation.italic, 'italic') }),
    ...(operation.fontName === undefined ? {} : { fontName: requireString(operation.fontName, 'fontName', 1, 120) }),
    ...(operation.fontSize === undefined ? {} : { fontSize: boundedNumber(operation.fontSize, 'fontSize', 1, 200) }),
    ...(operation.color === undefined ? {} : { color: requireHexColor(operation.color) }),
  };
}

function wordTableRows(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new CompanionError('rows 必须包含 1-200 行', 'INVALID_ARGUMENT');
  }
  let columns: number | undefined;
  return value.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow) || rawRow.length < 1 || rawRow.length > 50) {
      throw new CompanionError(`rows[${String(rowIndex)}] 必须包含 1-50 列`, 'INVALID_ARGUMENT');
    }
    columns ??= rawRow.length;
    if (rawRow.length !== columns) throw new CompanionError('表格每行列数必须一致', 'INVALID_ARGUMENT');
    return rawRow.map((cell, columnIndex) => requireString(cell, `rows[${String(rowIndex)}][${String(columnIndex)}]`, 0, 20_000));
  });
}

function assertOfficeExtension(application: OfficeApplication, relative: string): void {
  if (!application.extensions.includes(path.extname(relative).toLowerCase())) {
    throw new CompanionError(
      `${application.label} 文档必须使用 ${application.extensions.join('、')} 扩展名`,
      'INVALID_ARGUMENT',
    );
  }
}

function temporaryOfficePath(target: string): string {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `.${parsed.name}.${randomBytes(8).toString('hex')}.office-tmp${parsed.ext}`);
}

async function runOfficePowerShell(
  script: string,
  request: Record<string, unknown>,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  const executable = process.env.DSH_LOCAL_WORKSPACE_TEST_WINDOWS === '1'
    ? process.env.DSH_LOCAL_WORKSPACE_TEST_POWERSHELL ?? 'powershell.exe'
    : 'powershell.exe';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: scrubEnvironment(process.env),
    windowsHide: true,
  });
  const stdout = collectStream(child.stdout, LOCAL_WORKSPACE_MAX_MESSAGE_BYTES);
  const stderr = collectStream(child.stderr, MAX_COMMAND_OUTPUT_BYTES);
  child.stdin?.end(JSON.stringify(request));
  let timedOut = false;
  let aborted = false;
  let terminating: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    terminating ??= terminateProcessTree(child);
    return terminating;
  };
  const onAbort = () => {
    aborted = true;
    void terminate();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);
  try {
    const exit = await waitForExit(child);
    if (terminating !== null) await terminating;
    const [out, err] = await Promise.all([stdout, stderr]);
    if (aborted) throw new CompanionError('Office 操作已取消', 'ABORTED');
    if (timedOut) throw new CompanionError('Office 操作超时', 'TIMEOUT');
    if (exit.code !== 0) throw new CompanionError(err.text.trim() || 'PowerShell Office 自动化失败', 'OFFICE_AUTOMATION_FAILED');
    let envelope: PowerShellEnvelope;
    try {
      envelope = JSON.parse(out.text) as PowerShellEnvelope;
    } catch {
      throw new CompanionError('PowerShell 返回了无效的 Office 结果', 'OFFICE_INVALID_RESPONSE');
    }
    if (envelope.ok !== true) {
      throw new CompanionError(envelope.error ?? 'Office 自动化失败', envelope.code ?? 'OFFICE_AUTOMATION_FAILED');
    }
    return envelope.value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function spawnCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  const windows = process.platform === 'win32';
  const executable = windows ? 'powershell.exe' : '/bin/bash';
  const argv = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['--noprofile', '--norc', '-lc', command];
  const child = spawn(executable, argv, {
    cwd,
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: scrubEnvironment(process.env),
    windowsHide: true,
  });
  const stdout = collectStream(child.stdout, MAX_COMMAND_OUTPUT_BYTES);
  const stderr = collectStream(child.stderr, MAX_COMMAND_OUTPUT_BYTES);
  let timedOut = false;
  let aborted = false;
  let terminating: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    terminating ??= terminateProcessTree(child);
    return terminating;
  };
  const onAbort = () => {
    aborted = true;
    void terminate();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);
  try {
    const exit = await waitForExit(child);
    if (terminating !== null) await terminating;
    const [out, err] = await Promise.all([stdout, stderr]);
    return {
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      aborted,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    await waitForExit(child).then(() => undefined, () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  const exited = await Promise.race([waitForExit(child).then(() => true), sleep(1_000).then(() => false)]);
  if (exited) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  await waitForExit(child).then(() => undefined, () => undefined);
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function collectStream(stream: NodeJS.ReadableStream | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: '', truncated: false };
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const remaining = Math.max(0, maxBytes - retained);
    if (remaining > 0) {
      const take = chunk.subarray(0, remaining);
      chunks.push(take);
      retained += take.length;
    }
    if (chunk.length > remaining) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function walkFiles(root: string, start: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const pending = [start];
  let seen = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (++seen > MAX_SEARCH_FILES) throw new CompanionError('搜索扫描文件数量超过 20000 上限', 'SEARCH_TOO_LARGE');
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = await existingPathWithin(root, path.relative(root, candidate));
          if ((await stat(resolved)).isFile()) files.push(resolved);
        } catch {
          continue;
        }
      } else if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      }
    }
  }
  return files;
}

async function existingPathWithin(root: string, relative: string): Promise<string> {
  const candidate = lexicalPathWithin(root, relative);
  const resolved = await realpath(candidate);
  ensureContained(root, resolved);
  return resolved;
}

async function writablePathWithin(root: string, relative: string): Promise<string> {
  const candidate = lexicalPathWithin(root, relative);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(candidate);
      ensureContained(root, resolved);
      return resolved;
    }
    ensureContained(root, await realpath(candidate));
    return candidate;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let ancestor = path.dirname(candidate);
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      ensureContained(root, resolved);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return candidate;
}

function lexicalPathWithin(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new CompanionError('只接受相对于授权目录的路径', 'PATH_OUTSIDE_ROOT');
  const candidate = path.resolve(root, relative);
  ensureContained(root, candidate);
  return candidate;
}

function ensureContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new CompanionError('路径超出授权目录', 'PATH_OUTSIDE_ROOT');
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    let mode = 0o600;
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) console.warn(`[dsh-local-workspace] 临时文件清理失败：${String(cleanupError)}`);
    }
    throw error;
  }
}

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index++;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(pattern.includes('/') ? `^${source}$` : `(?:^|/)${source}$`, 'u');
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let at = 0;
  while ((at = content.indexOf(needle, at)) !== -1) {
    count++;
    at += needle.length;
  }
  return count;
}

function scrubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE)/i.test(key)) continue;
    if (key === 'NODE_OPTIONS' || key === 'SSH_AUTH_SOCK') continue;
    clean[key] = value;
  }
  clean.DSH_LOCAL_WORKSPACE = '1';
  return clean;
}

function parseRequest(value: Record<string, unknown>): LocalWorkspaceRequest {
  const operation = value.operation;
  if (operation !== 'read' && operation !== 'write' && operation !== 'edit' && operation !== 'glob' && operation !== 'grep' && operation !== 'bash' && operation !== 'office' && operation !== 'files') {
    throw new Error('unsupported operation');
  }
  if (value.args === null || typeof value.args !== 'object' || Array.isArray(value.args)) throw new Error('request args must be an object');
  return {
    type: 'request',
    id: requireString(value.id, 'id', 1, 120),
    operation,
    args: value.args as Record<string, unknown>,
  };
}

function requireRelativePath(value: unknown, name: string): string {
  const pathValue = requireString(value, name, 1, 4096).replace(/\\/g, '/');
  if (pathValue.includes('\0')) throw new CompanionError(`${name} 包含空字符`, 'INVALID_ARGUMENT');
  return pathValue;
}

function optionalRelativePath(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireRelativePath(value, name);
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionError(message, 'INVALID_ARGUMENT');
  }
  return value as Record<string, unknown>;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  name: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new CompanionError(`${name} 必须是 ${values.join('、')} 之一`, 'INVALID_ARGUMENT');
  }
  return value as Values[number];
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new CompanionError(`${name} 必须是布尔值`, 'INVALID_ARGUMENT');
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const result = optionalPositiveInteger(value, name);
  if (result === undefined) throw new CompanionError(`${name} 必须是正整数`, 'INVALID_ARGUMENT');
  return result;
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CompanionError(`${name} 必须在 ${String(minimum)}-${String(maximum)} 之间`, 'INVALID_ARGUMENT');
  }
  return value;
}

function requireHexColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/u.test(value)) {
    throw new CompanionError('color 必须是 #RRGGBB', 'INVALID_ARGUMENT');
  }
  return value.toUpperCase();
}

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > max) {
    throw new CompanionError(`${name} 长度无效`, 'INVALID_ARGUMENT');
  }
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new CompanionError(`${name} 必须是正整数`, 'INVALID_ARGUMENT');
  return value as number;
}

function displayPath(relative: string): string {
  const normalized = relative.split(path.sep).join('/');
  return normalized === '' ? '.' : normalized;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CompanionError('operation aborted', 'ABORTED');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

async function configExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function storedConfigPaths(defaultConfigPath: string): Promise<string[]> {
  const configs: string[] = [];
  if (await configExists(defaultConfigPath)) configs.push(defaultConfigPath);
  const profiles = path.join(path.dirname(defaultConfigPath), 'profiles');
  try {
    const entries = await readdir(profiles, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile()
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(entry.name)
      ) {
        configs.push(path.join(profiles, entry.name));
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return configs.sort();
}

function parseDisplayedDeviceCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{3} [0-9]{3}$/.test(value)) {
    throw new CompanionError('服务器返回的设备确认码格式无效', 'PROTOCOL_ERROR');
  }
  return value;
}

function parseDeviceCodeExpiry(value: unknown): Date {
  if (typeof value !== 'string' || value.length > 100) {
    throw new CompanionError('服务器返回的确认码有效期格式无效', 'PROTOCOL_ERROR');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new CompanionError('服务器返回的确认码有效期格式无效', 'PROTOCOL_ERROR');
  }
  return new Date(time);
}

/** Long-lived device credentials are opaque, high-entropy strings; never persist short user codes. */
function parseDeviceToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 32 || bytes > 300 || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  return value;
}

function printDeviceApproval(code: string, expiresAt: Date): void {
  console.log('');
  console.log('==================================================');
  console.log('                 设备确认码');
  console.log('');
  console.log(`                    ${code}`);
  console.log('');
  console.log('请在已登录的 dsh 网页中打开：');
  console.log('设置 → 插件 → 本机工作区，输入上面的 6 位确认码。');
  console.log(`有效期至：${expiresAt.toLocaleString()}`);
  console.log('正在等待网页确认，请不要关闭此窗口…');
  console.log('==================================================');
  console.log('');
}

async function runFirstPairingWizard(defaults: CliOptions): Promise<CliOptions> {
  const forceWizard = process.env.DSH_LOCAL_WORKSPACE_FORCE_WIZARD === '1';
  if (!forceWizard && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('首次连接需要提供 --server 和 --folder；旧版长配对码可继续使用 --pair');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('==================================================');
    console.log('       山东梯智物联AI · DSH 本机助手');
    console.log('==================================================');
    console.log('首次配置一次，之后双击本程序即可自动连接。');
    console.log('连接后会显示 6 位确认码，请在已登录的 DSH 网页中批准。');
    console.log('');
    const serverInput = await terminal.question(
      '1. 输入服务器 ws:// 或 wss:// 地址（也可粘贴旧版完整配对命令）：\n> ',
    );
    const legacy = parsePairingInput(serverInput);
    const server = legacy.server ?? (
      legacy.pairCode === undefined
        ? stripOuterQuotes(serverInput)
        : stripOuterQuotes(await terminal.question('   旧命令中没有服务器地址，请输入 ws:// 或 wss:// 地址：\n> '))
    );
    const folder = stripOuterQuotes(await terminal.question('2. 输入或拖入要授权的本机文件夹：\n> '));
    const shellAnswer = (await terminal.question('3. 允许 AI 在本机执行 PowerShell 命令？风险较高 [y/N]：\n> ')).trim();
    const desktopAnswer = (await terminal.question(
      '4. 允许 AI 截取本机屏幕并操作鼠标键盘？截屏会拍到所有可见窗口，风险很高 [y/N]：\n> ',
    )).trim();
    console.log('正在验证目录并连接服务器…');
    return {
      ...defaults,
      server,
      pairCode: legacy.pairCode,
      folder,
      allowShell: /^(?:y|yes|是)$/i.test(shellAnswer),
      allowDesktop: /^(?:y|yes|是)$/i.test(desktopAnswer),
    };
  } finally {
    terminal.close();
  }
}

function parsePairingInput(input: string): { server?: string; pairCode?: string } {
  const value = input.trim();
  const explicitPair = flagValue(value, '--pair');
  return {
    server: flagValue(value, '--server'),
    pairCode: explicitPair ?? (/^[A-Za-z0-9_-]{32,200}$/.test(value) ? value : undefined),
  };
}

function flagValue(command: string, flag: string): string | undefined {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'u').exec(command);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : stripOuterQuotes(value);
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isWindowsRuntime(): boolean {
  return process.platform === 'win32' || process.env.DSH_LOCAL_WORKSPACE_TEST_WINDOWS === '1';
}

function isPackagedRuntime(): boolean {
  return (
    (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
    || process.env.DSH_LOCAL_WORKSPACE_TEST_PACKAGED === '1'
  );
}

async function ensureWindowsProtocolRegistration(): Promise<void> {
  const key = `HKCU\\Software\\Classes\\${WINDOWS_PROTOCOL}`;
  const command = windowsProtocolCommand();
  const icon = `${quoteWindowsCommandArgument(process.execPath)},0`;
  const entries: string[][] = [
    ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', 'URL:DSH Local Workspace', '/f'],
    ['ADD', key, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
    ['ADD', `${key}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', icon, '/f'],
    ['ADD', `${key}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
  ];
  try {
    for (const args of entries) {
      const child = spawn('reg.exe', args, { stdio: 'ignore', windowsHide: true });
      const result = await waitForExit(child);
      if (result.code !== 0) throw new Error('registry command failed');
    }
  } catch {
    console.warn('[dsh-local-workspace] 无法注册网页一键唤起；仍可使用 --setup 或命令行参数。');
  }
}

function windowsProtocolCommand(): string {
  const packaged = (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined;
  const values = [process.execPath];
  if (!packaged) {
    const entry = process.argv[1];
    if (entry === undefined || entry === '') throw new Error('无法确定本机助手入口文件');
    values.push(path.resolve(entry));
  }
  values.push('--allow-shell', '%1');
  return values.map(quoteWindowsCommandArgument).join(' ');
}

/** Quote one argument using the Windows CommandLineToArgvW/CRT escaping rules. */
function quoteWindowsCommandArgument(value: string): string {
  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return result + '\\'.repeat(backslashes * 2) + '"';
}

async function chooseWindowsFolder(): Promise<string | null> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "请选择要授权给 DSH 的本机文件夹"',
    '$dialog.ShowNewFolderButton = $true',
    'try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath); exit 0 }; exit 2 } finally { $dialog.Dispose() }',
  ].join('; ');
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
    );
    const [result, stdout] = await Promise.all([
      waitForExit(child),
      collectStream(child.stdout, 32 * 1024),
      collectStream(child.stderr, 32 * 1024),
    ]);
    if (result.code === 2) return null;
    if (result.code !== 0 || stdout.truncated) throw new Error('folder picker failed');
    const selected = stdout.text.trim();
    if (selected === '' || Buffer.byteLength(selected, 'utf8') > 4_096 || /[\u0000-\u001f\u007f]/u.test(selected)) {
      throw new Error('folder picker returned an invalid path');
    }
    return selected;
  } catch {
    throw new CompanionError('无法打开 Windows 文件夹选择器；请使用 --setup 备用流程', 'FOLDER_PICKER_FAILED');
  }
}

async function pauseBeforeWindowsExit(): Promise<void> {
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question('按回车键关闭窗口…');
  } finally {
    terminal.close();
  }
}

async function waitAfterWindowsInstallation(): Promise<void> {
  if (process.platform !== 'win32') return;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await pauseBeforeWindowsExit();
    return;
  }
  if (process.env.CI !== undefined) return;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.MessageBox]::Show("网页一键选择已安装。请返回已登录的 dsh 网页，点击‘选择本机文件夹’。", "DSH 本机助手", "OK", "Information") | Out-Null',
  ].join('; ');
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: 'ignore', windowsHide: true },
    );
    await waitForExit(child);
  } catch {
    // Protocol registration already succeeded; lack of a GUI prompt must not
    // undo it. The console text remains available when launched in a terminal.
  }
}

async function resolveConfig(cli: CliOptions): Promise<CompanionConfig> {
  let saved: CompanionConfig | null = null;
  const launching = cli.launchTicket !== undefined;
  if (!launching) {
    try {
      saved = JSON.parse(await readFile(cli.configPath, 'utf8')) as CompanionConfig;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const folderInput = cli.folder ?? saved?.root;
  if (folderInput === undefined) throw new Error('首次配对必须提供 --folder <目录>');
  const root = await realpath(path.resolve(folderInput));
  if (!(await stat(root)).isDirectory()) throw new Error(`不是目录：${root}`);
  const server = cli.server ?? saved?.server;
  if (server === undefined) throw new Error('首次配对必须提供 --server <ws://或wss://地址>');
  const parsed = new URL(server);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('--server 必须使用 ws:// 或 wss://');
  const workspaceId = cli.launchWorkspaceId ?? saved?.workspaceId ?? randomUUID();
  const deviceName = cli.deviceName ?? saved?.deviceName ?? os.hostname();
  const workspaceName = cli.workspaceName ?? (launching ? path.basename(root) : saved?.workspaceName) ?? path.basename(root);
  const shellEnabled = (
    cli.allowShell
    || (isWindowsRuntime() && isPackagedRuntime())
    || (!launching && saved?.shellEnabled === true)
  );
  const token = launching ? undefined : parseDeviceToken(saved?.token);
  if (!launching && saved?.token !== undefined && token === undefined) {
    throw new Error(`配置文件中的设备令牌格式无效：${cli.configPath}`);
  }
  // Desktop control is never inferred from a packaged Windows runtime the way
  // Shell is: a capture exposes every window on the screen, so it stays off
  // until this run or the saved configuration was granted it explicitly.
  const desktopControl = cli.allowDesktop || (!launching && saved?.desktopControl === true);
  if (shellEnabled) {
    console.warn('[dsh-local-workspace] 警告：Shell 命令以当前系统用户身份执行，可能访问授权目录之外的文件。');
  }
  if (desktopControl) {
    console.warn('[dsh-local-workspace] 警告：桌面控制会截取整个屏幕（包括密码管理器等窗口），并向当前焦点窗口发送鼠标键盘操作。');
  }
  return {
    server: parsed.toString(),
    token,
    workspaceId,
    deviceName,
    workspaceName,
    root,
    shellEnabled,
    desktopControl,
  };
}

async function saveConfig(file: string, config: CompanionConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows does not implement POSIX mode bits; the user profile directory remains the owner boundary.
  }
}

function parseArgs(args: string[]): CliOptions {
  const result = defaultCliOptions();
  const protocolArguments = args.filter((arg) => /^dsh-local-workspace:/iu.test(arg));
  if (protocolArguments.length > 0) {
    const allowShellArguments = args.filter((arg) => arg === '--allow-shell');
    const allowDesktopArguments = args.filter((arg) => arg === '--allow-desktop');
    if (
      protocolArguments.length !== 1
      || allowShellArguments.length > 1
      || allowDesktopArguments.length > 1
      || args.length !== protocolArguments.length + allowShellArguments.length + allowDesktopArguments.length
    ) {
      throw invalidLaunchUri();
    }
    const protocolArgument = protocolArguments[0];
    if (protocolArgument === undefined) throw invalidLaunchUri();
    const launch = parseLaunchUri(protocolArgument);
    const launchWorkspaceId = randomUUID();
    return {
      ...result,
      allowShell: allowShellArguments.length === 1,
      allowDesktop: allowDesktopArguments.length === 1,
      configPath: path.join(path.dirname(result.configPath), 'profiles', `${launchWorkspaceId}.json`),
      launchTicket: launch.ticket,
      launchWorkspaceId,
      server: launch.server,
    };
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--allow-shell') result.allowShell = true;
    else if (arg === '--allow-desktop') result.allowDesktop = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--setup') result.setup = true;
    else if (arg === '--server') result.server = nextArg(args, ++index, '--server');
    else if (arg === '--pair') result.pairCode = nextArg(args, ++index, '--pair');
    else if (arg === '--folder') result.folder = nextArg(args, ++index, '--folder');
    else if (arg === '--device-name') result.deviceName = nextArg(args, ++index, '--device-name');
    else if (arg === '--name') result.workspaceName = nextArg(args, ++index, '--name');
    else if (arg === '--config') result.configPath = path.resolve(nextArg(args, ++index, '--config'));
    else throw new Error('未知参数；请使用 --help 查看用法');
  }
  if (result.pairCode !== undefined && result.pairCode.length < 32) throw new Error('配对码无效');
  return result;
}

function defaultCliOptions(configPath = path.join(os.homedir(), '.dsh-local-workspace', 'config.json')): CliOptions {
  return {
    configPath,
    allowShell: false,
    allowDesktop: false,
    help: false,
    setup: false,
  };
}

function parseLaunchUri(raw: string): { server: string; ticket: string } {
  try {
    if (
      raw.length > MAX_LAUNCH_URI_LENGTH
      || !WINDOWS_PROTOCOL_PREFIXES.some((prefix) => raw.startsWith(prefix))
      || /[\u0000-\u0020\u007f]/u.test(raw)
    ) {
      throw invalidLaunchUri();
    }
    const uri = new URL(raw);
    if (
      uri.protocol !== `${WINDOWS_PROTOCOL}:`
      || uri.username !== ''
      || uri.password !== ''
      || uri.host !== 'connect'
      || (uri.pathname !== '' && uri.pathname !== '/')
      || uri.hash !== ''
    ) {
      throw invalidLaunchUri();
    }
    const keys = [...uri.searchParams.keys()];
    if (
      keys.length !== 2
      || uri.searchParams.getAll('server').length !== 1
      || uri.searchParams.getAll('ticket').length !== 1
      || !keys.includes('server')
      || !keys.includes('ticket')
    ) {
      throw invalidLaunchUri();
    }
    const serverValue = uri.searchParams.get('server');
    const ticket = uri.searchParams.get('ticket');
    if (
      serverValue === null
      || serverValue.length === 0
      || serverValue.length > MAX_SERVER_URL_LENGTH
      || /[\u0000-\u0020\u007f]/u.test(serverValue)
      || ticket === null
      || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)
    ) {
      throw invalidLaunchUri();
    }
    const server = new URL(serverValue);
    if (
      (server.protocol !== 'ws:' && server.protocol !== 'wss:')
      || server.hostname === ''
      || server.username !== ''
      || server.password !== ''
      || server.hash !== ''
    ) {
      throw invalidLaunchUri();
    }
    return { server: server.toString(), ticket };
  } catch {
    throw invalidLaunchUri();
  }
}

function invalidLaunchUri(): Error {
  // Never interpolate the URI: it contains the two-minute bearer ticket.
  return new Error('网页一键连接链接无效或已损坏');
}

function nextArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  return value;
}

function printHelp(): void {
  console.log(`山东梯智物联AI · DSH 本机助手

Windows 用户首次双击 EXE 会为当前用户安装网页一键唤起。
返回 dsh 网页点击“选择本机文件夹”，再在 Windows 原生选择器中选择目录。
Windows EXE 会自动启用 PowerShell（包括已有工作区），并以当前系统用户权限执行命令。
网页启动链接只供操作系统调用，不要手工粘贴或分享。

手动配置向导（6 位确认码备用流程）：
  dsh-local-workspace --setup

无交互手动连接（连接后在网页输入助手显示的 6 位码）：
  dsh-local-workspace --server ws://服务器:3082 --folder <目录> [--name 名称]

旧版长配对码（兼容）：
  dsh-local-workspace --server ws://服务器:3082 --pair <长配对码> --folder <目录>

恢复连接：
  dsh-local-workspace

选项：
  --setup             打开控制台手动配置向导
  --server URL        本机助手 WebSocket 地址（ws:// 或 wss://）
  --folder PATH       要授权的本机目录
  --pair CODE         旧版一次性长配对码；新设备确认流程不需要
  --name NAME         工作区显示名；默认使用目录名
  --allow-shell       非 Windows EXE 命令行模式明确允许 AI 执行 Shell；默认关闭
  --allow-desktop     允许 AI 截取本机屏幕并操作鼠标键盘；默认关闭，且不会被任何
                      运行方式自动开启。截屏会拍到全部可见窗口，输入会进入当前焦点窗口
  --device-name NAME  设备显示名
  --config PATH       使用另一份配置文件（可同时共享多个目录）
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
