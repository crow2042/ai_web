$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$readme = Join-Path $root "README.md"
$out = Join-Path $root "README.docx"

if (Test-Path -LiteralPath $out) {
  Remove-Item -LiteralPath $out -Force
}

function Escape-Xml([string]$text) {
  return [System.Security.SecurityElement]::Escape($text)
}

$lines = Get-Content -LiteralPath $readme -Encoding UTF8
$paragraphs = New-Object System.Collections.Generic.List[string]
$inCode = $false

foreach ($line in $lines) {
  if ($line -match '^```') {
    $inCode = -not $inCode
    continue
  }

  if ($line -match '^# (.+)') {
    $text = Escape-Xml $Matches[1]
    $paragraphs.Add("<w:p><w:pPr><w:pStyle w:val=""Title""/></w:pPr><w:r><w:t>$text</w:t></w:r></w:p>")
    continue
  }

  if ($line -match '^## (.+)') {
    $text = Escape-Xml $Matches[1]
    $paragraphs.Add("<w:p><w:pPr><w:pStyle w:val=""Heading1""/></w:pPr><w:r><w:t>$text</w:t></w:r></w:p>")
    continue
  }

  if ($line -match '^- (.+)') {
    $text = Escape-Xml $Matches[1]
    $paragraphs.Add("<w:p><w:pPr><w:pStyle w:val=""ListParagraph""/></w:pPr><w:r><w:t>- $text</w:t></w:r></w:p>")
    continue
  }

  if ($line.Trim().Length -eq 0) {
    $paragraphs.Add("<w:p/>")
    continue
  }

  $text = Escape-Xml $line
  if ($inCode) {
    $paragraphs.Add("<w:p><w:r><w:rPr><w:rFonts w:ascii=""Consolas"" w:hAnsi=""Consolas"" w:eastAsia=""Microsoft YaHei""/></w:rPr><w:t>$text</w:t></w:r></w:p>")
  } else {
    $paragraphs.Add("<w:p><w:r><w:t>$text</w:t></w:r></w:p>")
  }
}

$body = $paragraphs -join ""
$documentXml = "<?xml version=""1.0"" encoding=""UTF-8"" standalone=""yes""?><w:document xmlns:w=""http://schemas.openxmlformats.org/wordprocessingml/2006/main""><w:body>$body<w:sectPr><w:pgSz w:w=""11906"" w:h=""16838""/><w:pgMar w:top=""1440"" w:right=""1440"" w:bottom=""1440"" w:left=""1440""/></w:sectPr></w:body></w:document>"
$contentTypes = "<?xml version=""1.0"" encoding=""UTF-8"" standalone=""yes""?><Types xmlns=""http://schemas.openxmlformats.org/package/2006/content-types""><Default Extension=""rels"" ContentType=""application/vnd.openxmlformats-package.relationships+xml""/><Default Extension=""xml"" ContentType=""application/xml""/><Override PartName=""/word/document.xml"" ContentType=""application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml""/><Override PartName=""/word/styles.xml"" ContentType=""application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml""/></Types>"
$rels = "<?xml version=""1.0"" encoding=""UTF-8"" standalone=""yes""?><Relationships xmlns=""http://schemas.openxmlformats.org/package/2006/relationships""><Relationship Id=""rId1"" Type=""http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"" Target=""word/document.xml""/></Relationships>"
$styles = "<?xml version=""1.0"" encoding=""UTF-8"" standalone=""yes""?><w:styles xmlns:w=""http://schemas.openxmlformats.org/wordprocessingml/2006/main""><w:style w:type=""paragraph"" w:default=""1"" w:styleId=""Normal""><w:name w:val=""Normal""/><w:rPr><w:rFonts w:ascii=""Microsoft YaHei"" w:hAnsi=""Microsoft YaHei"" w:eastAsia=""Microsoft YaHei""/><w:sz w:val=""22""/></w:rPr></w:style><w:style w:type=""paragraph"" w:styleId=""Title""><w:name w:val=""Title""/><w:rPr><w:b/><w:sz w:val=""36""/><w:rFonts w:ascii=""Microsoft YaHei"" w:hAnsi=""Microsoft YaHei"" w:eastAsia=""Microsoft YaHei""/></w:rPr></w:style><w:style w:type=""paragraph"" w:styleId=""Heading1""><w:name w:val=""heading 1""/><w:basedOn w:val=""Normal""/><w:rPr><w:b/><w:sz w:val=""28""/><w:color w:val=""5F35DC""/></w:rPr></w:style><w:style w:type=""paragraph"" w:styleId=""ListParagraph""><w:name w:val=""List Paragraph""/><w:basedOn w:val=""Normal""/><w:pPr><w:ind w:left=""360""/></w:pPr></w:style></w:styles>"

function Add-ZipEntry($zip, [string]$name, [string]$content) {
  $entry = $zip.CreateEntry($name)
  $writer = New-Object System.IO.StreamWriter($entry.Open(), [System.Text.UTF8Encoding]::new($false))
  try {
    $writer.Write($content)
  } finally {
    $writer.Dispose()
  }
}

$stream = [System.IO.File]::Open($out, [System.IO.FileMode]::CreateNew)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Add-ZipEntry $zip "[Content_Types].xml" $contentTypes
    Add-ZipEntry $zip "_rels/.rels" $rels
    Add-ZipEntry $zip "word/document.xml" $documentXml
    Add-ZipEntry $zip "word/styles.xml" $styles
  } finally {
    $zip.Dispose()
  }
} finally {
  $stream.Dispose()
}

Write-Output $out
