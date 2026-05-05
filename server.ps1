$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublicDir = Join-Path $Root "public"
$DataDir = Join-Path $Root "data"
$GeneratedDir = Join-Path $DataDir "generated"
$ConfigFile = Join-Path $DataDir "config.json"
$LogFile = Join-Path $DataDir "generations.jsonl"
$RecordFile = Join-Path $DataDir "records.jsonl"
$PromptRecordFile = Join-Path $DataDir "prompt-records.jsonl"
$Port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$Sessions = [hashtable]::Synchronized(@{})
$DataLock = New-Object object

function ConvertTo-JsonText($Value) {
  return ($Value | ConvertTo-Json -Depth 20 -Compress)
}

function Get-PasswordHash([string]$Password, [string]$Salt) {
  $saltBytes = [Text.Encoding]::UTF8.GetBytes($Salt)
  $derive = New-Object Security.Cryptography.Rfc2898DeriveBytes($Password, $saltBytes, 120000, [Security.Cryptography.HashAlgorithmName]::SHA256)
  return [BitConverter]::ToString($derive.GetBytes(32)).Replace("-", "").ToLowerInvariant()
}

function Ensure-Data {
  if (!(Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  if (!(Test-Path $GeneratedDir)) { New-Item -ItemType Directory -Path $GeneratedDir | Out-Null }
  if (!(Test-Path $ConfigFile)) {
    $bytes = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $salt = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
    $config = [ordered]@{
      admin = [ordered]@{ username = "admin"; salt = $salt; hash = (Get-PasswordHash -Password "1596357" -Salt $salt) }
      apis = @()
    }
    Set-Content -Path $ConfigFile -Value ($config | ConvertTo-Json -Depth 20) -Encoding UTF8
  }
}

function Read-Config {
  Ensure-Data
  [Threading.Monitor]::Enter($DataLock)
  try {
    $config = Get-Content -Raw -Path $ConfigFile -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.PSObject.Properties["apis"]) { $config | Add-Member -NotePropertyName apis -NotePropertyValue @() }
    Ensure-LlmApisProperty $config
    if (-not $config.PSObject.Properties["adminUsers"]) { $config | Add-Member -NotePropertyName adminUsers -NotePropertyValue @() }
    return $config
  } finally {
    [Threading.Monitor]::Exit($DataLock)
  }
}

function Save-Config($Config) {
  [Threading.Monitor]::Enter($DataLock)
  try {
    Set-Content -Path $ConfigFile -Value ($Config | ConvertTo-Json -Depth 20) -Encoding UTF8
  } finally {
    [Threading.Monitor]::Exit($DataLock)
  }
}

function Add-Log($Entry) {
  [Threading.Monitor]::Enter($DataLock)
  try {
    Add-Content -Path $LogFile -Value (ConvertTo-JsonText $Entry) -Encoding UTF8
    Add-Content -Path $RecordFile -Value (ConvertTo-JsonText (Get-CompactRecord $Entry)) -Encoding UTF8
  } finally {
    [Threading.Monitor]::Exit($DataLock)
  }
}

function Get-CompactRecord($Entry) {
  return [ordered]@{
    time = $Entry.time
    visitor = $Entry.visitor
    requestMode = $Entry.requestMode
    clientId = $Entry.clientId
    model = $Entry.model
    modelId = $Entry.modelId
    prompt = $Entry.prompt
    aspect = $Entry.aspect
    size = $Entry.size
    referenceName = $Entry.referenceName
    referencePreviews = $Entry.referencePreviews
    count = $Entry.count
    outputs = $Entry.outputs
    status = $Entry.status
    error = $Entry.error
  }
}

function Get-ApiRequestMode([string]$Endpoint) {
  $text = ([string]$Endpoint).ToLowerInvariant()
  if ($text -match '/images?/(edit|edits)/?$') { return "edit" }
  return "generation"
}

function Get-NormalizedImageSize($Value) {
  $text = ([string]$Value).Trim().ToLowerInvariant() -replace '[×＊*]', 'x'
  if (!$text) { return "" }
  if ($text -eq "auto") { return "auto" }
  if ($text -match '^(\d{2,5})\s*x\s*(\d{2,5})$') {
    $w = [int]$Matches[1]
    $h = [int]$Matches[2]
    if ($w -ge 64 -and $h -ge 64 -and $w -le 8192 -and $h -le 8192) { return "$($w)x$($h)" }
  }
  return ""
}

function Get-SupportedSizes($Api) {
  $raw = @()
  if ($Api -and $Api.PSObject.Properties["supportedSizes"] -and $Api.supportedSizes) { $raw += @(Get-ValueList $Api.supportedSizes) }
  if ($Api -and $Api.PSObject.Properties["size"] -and $Api.size) { $raw += [string]$Api.size }
  $sizes = @()
  foreach ($item in $raw) {
    foreach ($part in ([string]$item -split '[\n,，;；]+')) {
      $size = Get-NormalizedImageSize $part
      if ($size -and $sizes -notcontains $size) { $sizes += $size }
    }
  }
  if (!$sizes.Count) { $sizes = @("1024x1024") }
  return @($sizes)
}

function Get-DefaultSize($Api) {
  $sizes = @(Get-SupportedSizes $Api)
  $size = Get-NormalizedImageSize $Api.size
  if ($size -and $sizes -contains $size) { return $size }
  return $sizes[0]
}

function Get-RequestSize($Api, $RequestedSize) {
  $sizes = @(Get-SupportedSizes $Api)
  $raw = ([string]$RequestedSize).Trim()
  $size = Get-NormalizedImageSize $raw
  if ($raw -and !$size) { throw "图片尺寸格式不正确，请选择当前模型支持的尺寸" }
  if ($size -and $sizes -notcontains $size) { throw "所选尺寸 $size 不在当前模型支持列表中" }
  if ($size) { return $size }
  return Get-DefaultSize $Api
}

function Get-SizePreset($Api) {
  $provider = $(if ($Api.provider) { ([string]$Api.provider).ToLowerInvariant() } else { "auto" })
  $model = ([string]$Api.model).ToLowerInvariant()
  $endpoint = ([string]$Api.endpoint).ToLowerInvariant()
  if ($provider -eq "auto") {
    if ($model -match '^gpt-image-' -or $endpoint -match 'openai|ticketpro') { $provider = "openai" }
    elseif ($model -match 'seedream|seededit' -or $endpoint -match 'volces|ark') { $provider = "ark" }
  }
  if ($provider -eq "openai") {
    if ($model -match 'dall-e-3') { return @("1024x1024", "1024x1792", "1792x1024") }
    if ($model -match 'dall-e-2') { return @("256x256", "512x512", "1024x1024") }
    return @("1024x1024", "1024x1536", "1536x1024")
  }
  if ($provider -eq "ark") { return @("1024x1024", "1024x1536", "1536x1024", "768x1344", "1344x768") }
  return @()
}

function Discover-ImageSizes($Api) {
  $preset = @(Get-SizePreset $Api)
  if ($preset.Count) {
    return [ordered]@{ supportedSizes = @($preset); defaultSize = $preset[0]; source = "preset"; note = "由模型适配器预设生成支持尺寸"; warnings = @() }
  }
  return [ordered]@{ supportedSizes = @("1024x1024"); defaultSize = "1024x1024"; source = "fallback"; note = "上游未暴露尺寸，请管理员手动确认后保存"; warnings = @("PowerShell 后端使用 fallback 尺寸") }
}

function Get-PayloadMessage($Payload, [string]$Fallback = "") {
  if ($null -eq $Payload) { return $Fallback }
  if ($Payload.PSObject.Properties["error"] -and $Payload.error) {
    if ($Payload.error -is [string] -and [string]::IsNullOrWhiteSpace([string]$Payload.error) -eq $false) {
      return [string]$Payload.error
    }
    if ($Payload.error.PSObject.Properties["message"] -and [string]::IsNullOrWhiteSpace([string]$Payload.error.message) -eq $false) {
      return [string]$Payload.error.message
    }
  }
  if ($Payload.PSObject.Properties["message"] -and [string]::IsNullOrWhiteSpace([string]$Payload.message) -eq $false) {
    return [string]$Payload.message
  }
  if ($Payload.PSObject.Properties["fail_reason"] -and [string]::IsNullOrWhiteSpace([string]$Payload.fail_reason) -eq $false) {
    return [string]$Payload.fail_reason
  }
  return $Fallback
}

function Get-ReferencePreviews($Names, $References, $IncomingPreviews) {
  $nameList = @()
  if ($Names) { $nameList = ([string]$Names).Split("、") }
  $refs = @(Get-ValueList $References)
  $incoming = @()
  if ($IncomingPreviews -is [array]) {
    $incoming = @($IncomingPreviews)
  } elseif ($IncomingPreviews) {
    $incoming = @($IncomingPreviews)
  }
  $items = @()
  for ($i = 0; $i -lt $refs.Count; $i++) {
    $incomingItem = $null
    if ($i -lt $incoming.Count) { $incomingItem = $incoming[$i] }
    $src = ""
    if ($incomingItem -and $incomingItem.src) {
      $candidate = [string]$incomingItem.src
      if ($candidate.Length -le 200000) { $src = $candidate }
    }
    $items += [ordered]@{
      name = $(if ($incomingItem -and $incomingItem.name) { [string]$incomingItem.name } elseif ($i -lt $nameList.Count -and $nameList[$i]) { $nameList[$i] } else { "参考图 $($i + 1)" })
      label = $(if ($incomingItem -and $incomingItem.label) { [string]$incomingItem.label } else { "参考图 $($i + 1)" })
      src = $src
    }
  }
  return @($items)
}

function Get-ValueList($Value) {
  $items = @()
  if ($null -eq $Value) { return @() }
  if ($Value -is [string]) {
    if ($Value) { $items += $Value }
    return @($items)
  }
  foreach ($item in @($Value)) {
    if ($null -eq $item) { continue }
    if ($item -is [string]) {
      if ($item) { $items += $item }
    } else {
      $text = [string]$item
      if ($text) { $items += $text }
    }
  }
  return @($items)
}

function Test-GptImageModel($Model) {
  return ([string]$Model) -match '^gpt-image-'
}

function Test-TicketproEndpoint($Endpoint) {
  try {
    return ([Uri]([string]$Endpoint)).Host.ToLowerInvariant() -eq "hk.ticketpro.cc"
  } catch {
    return $false
  }
}

function Get-CleanHeaderValue($Value, [string]$FieldName) {
  $text = ([string]$Value).Normalize([Text.NormalizationForm]::FormKC).Trim()
  $text = $text -replace '^(?i)Bearer\s+', ''
  foreach ($ch in $text.ToCharArray()) {
    if ([int][char]$ch -gt 255) {
      throw "$FieldName 包含不能用于 HTTP 请求头的字符：$ch。请检查是否复制了中文括号、中文说明或多余空格。"
    }
  }
  return $text
}

function Get-AuthHeaders($Api) {
  $apiKey = Get-CleanHeaderValue $Api.apiKey "API Key"
  return @{ Authorization = "Bearer $apiKey" }
}

function Get-ImageEndpoint($Endpoint, [string]$Action) {
  try {
    $builder = [UriBuilder]::new([string]$Endpoint)
    $basePath = (($builder.Path -replace '/images?/(generations|edits)/?$', '')).TrimEnd('/')
    $builder.Path = "$basePath/images/$Action"
    return $builder.Uri.AbsoluteUri
  } catch {
    $base = (([string]$Endpoint) -replace '/images?/(generations|edits)/?$', '').TrimEnd('/')
    return "$base/images/$Action"
  }
}

function Get-UploadEndpoint($Endpoint) {
  try {
    $builder = [UriBuilder]::new([string]$Endpoint)
    $builder.Path = ($builder.Path -replace '/images/generations/?$', '/uploads/images')
    return $builder.Uri.AbsoluteUri
  } catch {
    return (([string]$Endpoint) -replace '/images/generations/?$', '/uploads/images')
  }
}

function ConvertFrom-DataUrl($DataUrl, [int]$Index) {
  $text = [string]$DataUrl
  $match = [regex]::Match($text, '^data:([^;,]+);base64,(.+)$')
  if (!$match.Success) { return $null }
  $mime = $match.Groups[1].Value
  $ext = "png"
  if ($mime -match 'jpeg') { $ext = "jpg" }
  elseif ($mime -match 'webp') { $ext = "webp" }
  elseif ($mime -match 'gif') { $ext = "gif" }
  return [ordered]@{
    bytes = [Convert]::FromBase64String($match.Groups[2].Value)
    mime = $mime
    name = "reference-$($Index + 1).$ext"
  }
}

function Get-SanitizedQuality($Value) {
  $text = ([string]$Value).Trim().ToLowerInvariant()
  if ($text -in @("low", "medium", "high")) { return $text }
  return ""
}

function Invoke-GptImageEdit($Api, [string]$Prompt, $Refs, [string]$Size, [string]$Quality) {
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $form = [System.Net.Http.MultipartFormDataContent]::new()
  $imageCount = 0
  try {
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", (Get-CleanHeaderValue $Api.apiKey "API Key"))
    $form.Add([System.Net.Http.StringContent]::new([string]$Api.model), "model")
    $form.Add([System.Net.Http.StringContent]::new($Prompt), "prompt")
    $form.Add([System.Net.Http.StringContent]::new("1"), "n")
    $form.Add([System.Net.Http.StringContent]::new($Size), "size")
    if ($Quality) {
      $form.Add([System.Net.Http.StringContent]::new($Quality), "quality")
    }

    $items = @(Get-ValueList $Refs)
    for ($i = 0; $i -lt $items.Count; $i++) {
      $ref = [string]$items[$i]
      $file = ConvertFrom-DataUrl -DataUrl $ref -Index $i
      if ($file) {
        $fileContent = [System.Net.Http.ByteArrayContent]::new([byte[]]$file.bytes)
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse([string]$file.mime)
        $form.Add($fileContent, "image", [string]$file.name)
        $imageCount++
      } elseif ($ref -match '^https?://') {
        $form.Add([System.Net.Http.StringContent]::new($ref), "image_url")
        $imageCount++
      }
    }
    if ($imageCount -eq 0) { return @() }

    $endpoint = Get-ImageEndpoint -Endpoint $Api.endpoint -Action "edits"
    $response = $client.PostAsync($endpoint, $form).Result
    $text = $response.Content.ReadAsStringAsync().Result
    try { $payload = ($text | ConvertFrom-Json) } catch { $payload = $null }
    if (!$response.IsSuccessStatusCode) {
      $message = Get-PayloadMessage -Payload $payload -Fallback $text
      throw $message
    }
    $images = @(Get-ImagesFromPayload $payload)
    if ($images.Count -eq 0) { $images = @(Wait-GenerationTask -Api $Api -Payload $payload -Endpoint $endpoint) }
    return @($images)
  } finally {
    $form.Dispose()
    $client.Dispose()
  }
}

function Invoke-UploadReferenceImage($Api, $DataUrl, [int]$Index) {
  $file = ConvertFrom-DataUrl -DataUrl $DataUrl -Index $Index
  if (!$file) { return "" }
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $form = [System.Net.Http.MultipartFormDataContent]::new()
  try {
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", (Get-CleanHeaderValue $Api.apiKey "API Key"))
    $fileContent = [System.Net.Http.ByteArrayContent]::new([byte[]]$file.bytes)
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse([string]$file.mime)
    $form.Add($fileContent, "file", [string]$file.name)
    $form.Add([System.Net.Http.StringContent]::new("generation"), "purpose")
    $response = $client.PostAsync((Get-UploadEndpoint $Api.endpoint), $form).Result
    $text = $response.Content.ReadAsStringAsync().Result
    try { $payload = ($text | ConvertFrom-Json) } catch { $payload = $null }
    if (!$response.IsSuccessStatusCode -or ($payload -and $payload.success -eq $false)) {
      $message = Get-PayloadMessage -Payload $payload -Fallback $text
      throw "上传参考图失败：$message"
    }
    $url = $(if ($payload -and $payload.PSObject.Properties["data"] -and $payload.data -and $payload.data.PSObject.Properties["url"] -and $payload.data.url) { $payload.data.url } elseif ($payload -and $payload.PSObject.Properties["url"] -and $payload.url) { $payload.url } elseif ($payload -and $payload.PSObject.Properties["image_url"] -and $payload.image_url) { $payload.image_url } else { "" })
    if (!$url) { throw "参考图上传成功，但未返回图片 URL" }
    return [string]$url
  } finally {
    $form.Dispose()
    $client.Dispose()
  }
}

function Get-ReferenceImageUrls($Api, $Refs) {
  $urls = @()
  $items = @(Get-ValueList $Refs)
  for ($i = 0; $i -lt $items.Count; $i++) {
    $ref = [string]$items[$i]
    if ($ref -match '^https?://') { $urls += $ref }
    elseif ($ref -match '^data:image/') { $urls += (Invoke-UploadReferenceImage -Api $Api -DataUrl $ref -Index $i) }
  }
  return @($urls | Where-Object { $_ })
}

function Send-Json($Response, [int]$Status, $Payload, $Headers = @{}) {
  $json = ConvertTo-JsonText $Payload
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Response.StatusCode = $Status
  $Response.ContentType = "application/json; charset=utf-8"
  foreach ($key in $Headers.Keys) { $Response.Headers[$key] = $Headers[$key] }
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Send-Binary($Response, [int]$Status, [byte[]]$Bytes, [string]$ContentType, $Headers = @{}) {
  $Response.StatusCode = $Status
  $Response.ContentType = $ContentType
  foreach ($key in $Headers.Keys) { $Response.Headers[$key] = $Headers[$key] }
  $Response.ContentLength64 = $Bytes.Length
  $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
  $Response.OutputStream.Close()
}

function Read-Body($Request) {
  if ($Request.ContentLength64 -le 0) { return @{} }
  if ($Request.ContentLength64 -gt 20971520) { throw "请求体过大" }
  $reader = New-Object IO.StreamReader($Request.InputStream, [Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($text)) { return @{} }
  return ($text | ConvertFrom-Json)
}

function Get-QueryParam($Request, [string]$Name) {
  $query = $Request.Url.Query
  if (!$query) { return "" }
  foreach ($part in $query.TrimStart("?").Split("&")) {
    if (!$part) { continue }
    $kv = $part.Split("=", 2)
    $key = [Uri]::UnescapeDataString($kv[0].Replace("+", " "))
    if ($key -eq $Name) {
      if ($kv.Count -lt 2) { return "" }
      return [Uri]::UnescapeDataString($kv[1].Replace("+", " "))
    }
  }
  return ""
}

function Get-CookieValue($Request, [string]$Name) {
  $cookie = $Request.Cookies[$Name]
  if ($cookie) { return $cookie.Value }
  return ""
}

function Test-Admin($Request) {
  $token = (Get-CookieValue -Request $Request -Name "admin_session")
  return ($token -and $Sessions.ContainsKey($token) -and $Sessions[$token] -gt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
}

function Get-PublicApis($Config) {
  $items = @()
  foreach ($api in @($Config.apis)) {
    $requestModes = @()
    if ($api.requestModes -is [array]) {
      $requestModes = @($api.requestModes | Where-Object { $_ -in @("generation", "edit") } | ForEach-Object { [string]$_ })
    } elseif ($api.requestMode) {
      $requestModes = @([string]$api.requestMode)
    } elseif ($api.enabled -ne $false) {
      $requestModes = @(Get-ApiRequestMode ([string]$api.endpoint))
    }
    if ($requestModes.Count -gt 0 -and $api.enabled -ne $false) {
      $items += [ordered]@{
        id = $api.id
        name = $api.name
        model = $api.model
        size = Get-DefaultSize $api
        supportedSizes = @(Get-SupportedSizes $api)
        sizeSource = $(if ($api.PSObject.Properties["sizeSource"] -and $api.sizeSource) { [string]$api.sizeSource } else { "legacy" })
        sizeDiscoveryNote = $(if ($api.PSObject.Properties["sizeDiscoveryNote"] -and $api.sizeDiscoveryNote) { [string]$api.sizeDiscoveryNote } else { "" })
        requestModes = @($requestModes)
        requestMode = $requestModes[0]
        provider = $(if ($api.provider) { [string]$api.provider } else { "auto" })
        useResponsesImageTool = $(if ($api.PSObject.Properties["useResponsesImageTool"]) { [bool]$api.useResponsesImageTool } else { $true })
        editModel = $(if ($api.editModel) { [string]$api.editModel } else { "" })
      }
    }
  }
  return $items
}

function Normalize-ReasoningEffort($Value) {
  $text = ([string]$(if ($Value) { $Value } else { "auto" })).Trim().ToLowerInvariant()
  if ($text -in @("auto", "low", "medium", "high")) { return $text }
  return "auto"
}

function Test-ReasoningEffortEnabled($Api) {
  return (Normalize-ReasoningEffort $Api.reasoningEffort) -in @("low", "medium", "high")
}

function Test-LikelyOpenAiReasoningModel($Model) {
  $text = ([string]$Model).ToLowerInvariant()
  return ($text -match '^(o1|o3|o4)(-|$)' -or $text -match '^gpt-5(\.\d+)?(-|$)')
}

function Add-ReasoningEffort($RequestBody, $Api, [bool]$IsResponsesApi) {
  if (!(Test-ReasoningEffortEnabled $Api) -or !(Test-LikelyOpenAiReasoningModel $Api.model)) { return }
  $effort = Normalize-ReasoningEffort $Api.reasoningEffort
  if ($IsResponsesApi) { $RequestBody["reasoning"] = [ordered]@{ effort = $effort } }
  else { $RequestBody["reasoning_effort"] = $effort }
}

function Get-PublicLlmApis($Config) {
  $items = @()
  foreach ($api in @($Config.llmApis)) {
    if ($api.enabled -ne $false) {
      $items += [ordered]@{
        id = $api.id
        name = $api.name
        model = $api.model
        endpoint = $api.endpoint
        reasoningEffort = Normalize-ReasoningEffort $api.reasoningEffort
      }
    }
  }
  return $items
}

function Ensure-LlmApisProperty($Config) {
  if (-not $Config.PSObject.Properties["llmApis"]) {
    $Config | Add-Member -NotePropertyName llmApis -NotePropertyValue @()
  }
}

function Add-PromptRecord($Entry) {
  [Threading.Monitor]::Enter($DataLock)
  try {
    Add-Content -Path $PromptRecordFile -Value (ConvertTo-JsonText $Entry) -Encoding UTF8
  } finally {
    [Threading.Monitor]::Exit($DataLock)
  }
}

function Read-PromptRecords {
  if (!(Test-Path $PromptRecordFile)) { return @() }
  $lines = Get-Content -Path $PromptRecordFile -Encoding UTF8 -Tail 200
  $records = @()
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $records += ($line | ConvertFrom-Json) } catch {}
  }
  return @($records)
}

function Read-ClientPromptRecords([string]$ClientId) {
  if (!$ClientId) { return @() }
  return @(Read-PromptRecords | Where-Object { $_.clientId -and $_.clientId -eq $ClientId })
}

function Get-ResponsesEndpoint($Endpoint) {
  $text = ([string]$Endpoint).Trim()
  if (!$text) { return "" }
  if ($text -match '/responses/?$') { return $text }
  $base = $text -replace '/images?/(generations|edits)/?$', '' -replace '/chat/completions/?$', ''
  return ($base.TrimEnd('/') + '/responses')
}

function Should-UseResponsesForReasoning($Api) {
  return (Test-ReasoningEffortEnabled $Api) -and (Test-LikelyOpenAiReasoningModel $Api.model)
}

function Get-ChatEndpoint($Endpoint, $Api = $null) {
  $text = ([string]$Endpoint).Trim()
  if (!$text) { return "" }
  if ($text -match '/responses/?$') { return $text }
  if ($Api -and (Should-UseResponsesForReasoning $Api)) { return Get-ResponsesEndpoint $text }
  if ($text -match '/chat/completions/?$') { return $text }
  if ($text -match '/v1/?$') { return ($text.TrimEnd('/') + '/chat/completions') }
  return ($text.TrimEnd('/') + '/chat/completions')
}

function Get-PromptSystemText([string]$Mode) {
  return @”
# image-prompt-orchestrator

你是图像任务 Prompt 编排器。你不会生成图片，只负责判断任务类型并输出最终发给生图模型的提示词。

## 0. 输出前必检清单（必须执行）

在输出 outputs 之前，必须先在内部完成下面判断：

1. 用户是否提供了参考图？
2. 用户是要”改原图”还是”参考风格生成新图”？
3. 如果是”参考图 + 生成新图”，必须在 outputs 中输出两个：
   - 1 个 JSON 结构化提示词版本，filename_suffix 为 `_json`
   - 1 个自然语言提示词版本，filename_suffix 为 `_plain`
4. 只有在以下情况才允许只输出 1 个 output：
   - 用户明确要求只要 1 个版本；
   - 用户是在”改图”，不是生图；
   - 用户没有提供参考图，且没有要求对比 JSON / 非 JSON。

硬性规则：
- “有参考图 + 生图”不得只输出 1 个 output。
- 不要把 JSON 和自然语言混在同一个 output 里。
- 稳做法：有参考图 + 生图时 outputs 数组必须有 2 个元素，分别对应 _json 和 _plain。

## 1. 先判断任务类型

### 改图 image_edit
满足任一条件，优先判断为改图：
- 用户提供了图片，并要求”把这张图改成 / 去掉 / 增加 / 缩小 / 放大 / 保持不变只改某处”。
- 用户强调保留原图：造型、比例、构图、颜色、光影、质感、主体轮廓、尺寸不变。
- 用户说”修改图 / 改图 / 基于这张图调整 / 只改 XX”。

典型例子：
- “把熊的围领去掉，问号放大一点。”
- “保持原图造型不变，改成果冻质感。”
- “把图片表情改成眼泪汪汪。”

### 生图 image_generation
满足任一条件，优先判断为生图：
- 用户要”生成一个 / 做一个 / 设计一个 / 出一版新角色 / 新坐骑 / 新皮肤”。
- 用户提供图片只是为了参考风格、质感、构图或氛围，不要求保留原图主体。
- 用户明确说”基于这张图风格，生成……”。

典型例子：
- “基于这张图风格，生成暗黑小恶魔。”
- “生成一只应龙，结合宇宙银河元素。”
- “做一个圆形外星人头，有猫耳朵和花朵触角。”

## 2. 输出策略

### A. 改图：默认只输出 1 个 JSON output
改图更依赖约束和局部控制，默认把用户需求压缩成一段 JSON prompt 输出。mode=image_edit，format=json。除非用户明确要求”不要 JSON / 要自然语言版”。改图时只输出 1 个 output。

### B. 生图 + 有参考图：必须输出两个 outputs
当用户提供参考图，并明确是”参考风格/质感/构图生图”时，必须在 outputs 数组中包含 2 个元素：
- 1 个 JSON 结构版：format=json，filename_suffix=_json，mode=img2img
- 1 个自然语言版：format=plain，filename_suffix=_plain，mode=img2img

硬性要求：
- outputs 数组长度必须等于 2。
- 两版应尽量保持同一需求核心一致，只改变提示词组织形式，方便用户比较 JSON 与非 JSON 的差异。
- 不能因为怕麻烦而省略其中一版。

### C. 生图 + 无参考图：只输出自然语言版
当用户只有纯文字描述、没有参考图时，默认只输出 1 个自然语言版 output。mode=text2img，format=plain。
原因：无参考图时，模型主要靠语义扩展，自然语言更灵活，JSON 不一定带来明显收益。
如果用户明确要求测试 JSON vs 非 JSON，即使没有参考图，也可以输出两版。

## 3. 改图 JSON 模板

默认按下面这个 JSON 结构生成改图 prompt。字段可以按实际需求微调，但整体结构优先保持一致。

{
  “task”: “image_edit”,
  “goal”: “本次改图目标，用简短英文或中文概括”,
  “keep_unchanged”: [
    “需要保持不变的内容1”,
    “需要保持不变的内容2”,
    “需要保持不变的内容3”
  ],
  “edit_area”: {
    “target”: “要修改的具体区域/对象”,
    “action”: “remove_completely / enlarge / reduce / replace / add / recolor / adjust”
  },
  “repair_instruction”: {
    “area”: “被修改后需要修补或自然衔接的位置”,
    “fill_with”: [
      “自然延续的结构/材质”,
      “连续光影”,
      “与原图一致的风格”
    ]
  },
  “style_requirement”: [
    “干净”,
    “精致”,
    “统一”,
    “正式游戏图标质感”
  ],
  “negative_prompt”: [
    “不要新增无关元素”,
    “不要改变主体轮廓”,
    “不要改变构图”,
    “不要改变颜色”,
    “不要改变风格”,
    “不要改变尺寸”
  ]
}

### 改图关键原则
- keep_unchanged 优先写：主体比例、构图、外框/轮廓、原有颜色、原有光影、原有材质、游戏图标风格。
- edit_area 只锁定真正要改的区域，避免模型误改其他部分。
- 删除/替换元素时，必须写 repair_instruction，说明被遮挡或删除后的区域如何自然补齐。
- negative_prompt 不要堆太多，只写最容易被误改的点。
- 如果用户要求多个修改点，可以把 edit_area 改成数组：edit_area: [{...}, {...}]。

## 4. 生图 JSON 固定模板

有参考图生图时，JSON 版必须优先使用下面固定模板。字段可按需求删减，但不要改成单字段短句；目的是让不同 AI 执行时更稳定，避免漏掉”参考图怎么用 / 生成什么 / 关键设计点 / 负向约束”。

{
  “task”: “image_generation_with_reference”,
  “reference_usage”: {
    “use_for”: [
      “参考图的风格质感”,
      “参考图的材质表现”,
      “参考图的配色氛围”,
      “参考图的精致度和图标完成度”
    ],
    “do_not_copy”: [
      “不要照抄参考图角色”,
      “不要照抄参考图结构”,
      “不要保留参考图中的具体装饰或文字”
    ]
  },
  “generate_target”: {
    “subject”: “要生成的主体，例如：1个史莱姆 / 1只坐骑 / 1个头像图标”,
    “theme”: “主题关键词，例如：可爱梦幻 / 暗黑机械 / 节日庆典”,
    “core_shape”: “主体大形，例如：圆形身体 / 竖向坐骑 / Q版头像”
  },
  “design_requirements”: {
    “silhouette”: [“主体轮廓要求”, “小图标下可读性要求”],
    “features”: [“关键特征1”, “关键特征2”, “关键特征3”],
    “expression_or_pose”: “表情或动作要求”,
    “materials”: [“材质1”, “材质2”],
    “effects”: [“特效1”, “特效2”]
  },
  “color_palette”: [“主色1”, “主色2”, “点缀色”],
  “composition”: {
    “aspect_ratio”: “1:1 / 16:9 / 其他”,
    “framing”: “居中、主体完整、构图饱满”,
    “background”: “背景要求，例如：简洁梦幻、不抢主体”
  },
  “quality_requirements”: [
    “高识别度”,
    “高完成度”,
    “干净精致”,
    “游戏资源质感”,
    “小图标可读性强”
  ],
  “negative_prompt”: [
    “不要写实”,
    “不要复杂背景”,
    “不要文字”,
    “不要多个主体”,
    “不要偏离目标主体”,
    “不要照抄参考图”
  ]
}

执行要求：
- JSON 版用这个模板生成 1 个 output，filename_suffix=_json。
- 自然语言版再按第 5 节生成 1 个 output，filename_suffix=_plain。
- 两版的信息量要接近，只改变组织形式，不要让 JSON 版和自然语言版变成两个不同需求。

## 5. 自然语言提示词写法

自然语言版不要只是把 JSON 翻译成散文，要更像给美术/生图模型的完整需求说明：

推荐顺序：
1. 参考图使用方式：参考什么，不照抄什么。
2. 主体与主题：生成什么，核心概念是什么。
3. 大形和构图：圆形身体、正视图、16:9、图标、坐骑展示等。
4. 关键设计点：特征部件、表情、动作、材质。
5. 特效和配色：高光、边缘光、星空、火焰、泡泡、果冻等。
6. 负向约束：不要杂乱、不要文字、不要恐怖、不要改主体等。

## 6. 输出与命名规范

- JSON 版 filename_suffix 用 `_json`。
- 自然语言版 filename_suffix 用 `_plain`。
- 改图 filename_suffix 用能描述修改点的英文短名。
- 若用户要求 16:9，设置 aspect_ratio 为 `16:9`。
- 若用户要求图标/头像，默认 1:1。

## 7. 输出格式（严格执行）

只返回严格 JSON，不要 markdown，不要解释。格式：
{“summary”:”一句话中文总结”,”needs_clarification”:false,”clarification_question”:””,”outputs”:[{“mode”:”text2img | img2img | image_edit”,”format”:”json | plain”,”filename_suffix”:”_json | _plain |”,”prompt”:”提示词文本，注意：format=json 时也必须把 JSON 对象序列化成字符串填入此字段，不要直接放对象”,”negative_prompt”:””}]}

**关键：prompt 字段的值必须是字符串。** 即使是 JSON 格式的提示词，也必须用 JSON.stringify 把对象转成字符串后填入 prompt，严禁把 JSON 对象直接放在 prompt 里。

## 8. 额外建议

- 对”测试 JSON vs 非 JSON”的任务，尽量让两版提示词的信息量接近，否则对比不公平。
- JSON 更适合：改图、多约束、多修改点、保留项多、数量限制明确的任务。
- 自然语言更适合：纯创意发散、没有参考图、需要模型自由发挥的任务。
- 如果用户在连续测试，应保持变量稳定：同一参考图、同一主体、同一尺寸/比例、同一数量，每次只改变提示词结构或单个需求点。
- 对游戏资源需求，优先补充”档位感/价值感/可读性/小图标识别度/特效不遮挡主体”等约束。

这是一个$(if ($Mode -eq “edit”) { “改图” } elseif ($Mode -eq “reference”) { “参考图生图” } else { “文生图” })需求。
“@
}

function Get-AssistantContentText($Payload) {
  if ($Payload.output_text) { return [string]$Payload.output_text }
  if ($Payload.output) {
    $parts = @()
    foreach ($output in @($Payload.output)) {
      foreach ($item in @($output.content)) {
        if ($item.text) { $parts += [string]$item.text }
        elseif ($item.content) { $parts += [string]$item.content }
      }
    }
    if ($parts.Count) { return ($parts -join "`n").Trim() }
  }
  if ($Payload.choices -and $Payload.choices.Count -gt 0) {
    $message = $Payload.choices[0].message
    if ($message.content -is [string]) { return [string]$message.content }
    $parts = @()
    foreach ($item in @($message.content)) {
      if ($item.text) { $parts += [string]$item.text }
      elseif ($item.content) { $parts += [string]$item.content }
    }
    return ($parts -join "`n").Trim()
  }
  return ""
}

function Parse-PromptCards([string]$Text) {
  $raw = $Text.Trim() -replace '^```json\s*', '' -replace '^```\s*', '' -replace '\s*```$', ''
  $start = $raw.IndexOf('{')
  $end = $raw.LastIndexOf('}')
  if ($start -ge 0 -and $end -gt $start) {
    $raw = $raw.Substring($start, $end - $start + 1)
  }
  try {
    $payload = $raw | ConvertFrom-Json
  } catch {
    return @([ordered]@{
      title = "模型返回 Prompt"
      subtitle = "模型未返回标准 JSON，已保留原始文本"
      content = $Text.Trim()
    })
  }
  $cards = @()
  foreach ($card in @($payload.cards)) {
    if ($card.title -and $card.content) {
      $cards += [ordered]@{
        title = [string]$card.title
        subtitle = [string]$card.subtitle
        content = [string]$card.content
      }
    }
  }
  return @($cards)
}

function Invoke-PromptOrchestratorLlm($Api, $Body) {
  $endpoint = Get-ChatEndpoint $Api.endpoint $Api
  if (!$endpoint) { throw "LLM API 地址不能为空" }
  $isResponsesApi = $endpoint -match '/responses/?$'
  $systemText = Get-PromptSystemText ([string]$Body.mode)
  $preserveText = if (@($Body.preserve).Count) { (@($Body.preserve) -join " | ") } else { "无" }
  $negativeText = if (@($Body.negative).Count) { (@($Body.negative) -join " | ") } else { "无" }
  $userText = @"
mode: $([string]$Body.mode)
aspectRatio: $([string]$Body.aspectRatio)
styleTone: $([string]$Body.styleTone)
description: $([string]$Body.description)
preserve: $preserveText
negative: $negativeText
imageCount: $(@(Get-ValueList $Body.imageDataUrls).Count)
"@
  $content = @(
    [ordered]@{ type = "text"; text = $userText.Trim() }
  )
  $imageUrls = @(Get-ValueList $Body.imageDataUrls)
  if (!$imageUrls.Count -and $Body.imageDataUrl) { $imageUrls = @([string]$Body.imageDataUrl) }
  foreach ($imageUrl in $imageUrls) {
    $content += [ordered]@{ type = "image_url"; image_url = [ordered]@{ url = [string]$imageUrl } }
  }
  if ($isResponsesApi) {
    $responseContent = @(
      [ordered]@{ type = "input_text"; text = ($systemText.Trim() + "`n`n用户输入：`n" + $userText.Trim()) }
    )
    foreach ($imageUrl in $imageUrls) {
      $responseContent += [ordered]@{ type = "input_image"; image_url = [string]$imageUrl }
    }
    $requestBody = [ordered]@{
      model = [string]$Api.model
      input = @(
        [ordered]@{ role = "user"; content = @($responseContent) }
      )
    }
  } else {
    $requestBody = [ordered]@{
      model = [string]$Api.model
      messages = @(
        [ordered]@{ role = "system"; content = $systemText.Trim() },
        [ordered]@{ role = "user"; content = @($content) }
      )
      response_format = [ordered]@{ type = "json_object" }
    }
  }
  Add-ReasoningEffort -RequestBody $requestBody -Api $Api -IsResponsesApi $isResponsesApi
  $headers = Get-AuthHeaders $Api
  $json = ($requestBody | ConvertTo-Json -Depth 30)
  $utf8Body = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    $result = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body $utf8Body -TimeoutSec 180
  } catch {
    $detail = $_.Exception.Message
    if ($_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        if ($text) { $detail = $text }
      } catch {}
    }
    throw $detail
  }
  $assistantText = Get-AssistantContentText $result
  $cards = @(Parse-PromptCards $assistantText)
  if (!$cards.Count) { throw "LLM 已返回结果，但未能解析出有效 Prompt 卡片" }
  return @($cards)
}

function Get-ImagesFromPayload($Payload) {
  $images = New-Object System.Collections.Generic.List[string]
  function Add-ImageValue($Value, [string]$Key = "") {
    if ($null -eq $Value) { return }
    if ($Value -is [string]) {
      if ($Value -match '^(https?://|data:image/)') { $images.Add($Value); return }
      if ($Key -match '^(b64_json|image_base64|base64|result)$' -and $Value -match '^[A-Za-z0-9+/=\r\n]+$' -and $Value.Length -gt 1000) {
        $images.Add("data:image/png;base64,$($Value -replace '\s+', '')")
      }
      return
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
      foreach ($item in @($Value)) { Add-ImageValue $item $Key }
      return
    }
    if ($Value.PSObject) {
      foreach ($itemKey in @("url", "image", "image_url", "output_url", "b64_json", "image_base64", "base64", "result")) {
        if ($Value.PSObject.Properties[$itemKey] -and $Value.$itemKey) { Add-ImageValue $Value.$itemKey $itemKey }
      }
      foreach ($itemKey in @("data", "images", "output", "outputs", "content")) {
        if ($Value.PSObject.Properties[$itemKey] -and $Value.$itemKey) { Add-ImageValue $Value.$itemKey $itemKey }
      }
    }
  }
  Add-ImageValue $Payload
  return @($images | Select-Object -Unique)
}

function Get-TaskId($Payload) {
  if ($Payload.id) { return [string]$Payload.id }
  if ($Payload.task_id) { return [string]$Payload.task_id }
  if ($Payload.data.id) { return [string]$Payload.data.id }
  if ($Payload.data.task_id) { return [string]$Payload.data.task_id }
  if ($Payload.data -and $Payload.data.Count -gt 0 -and $Payload.data[0].task_id) { return [string]$Payload.data[0].task_id }
  return ""
}

function Wait-GenerationTask($Api, $Payload, $Endpoint = $null) {
  $taskId = Get-TaskId $Payload
  if (!$taskId) { return @() }
  $endpointValue = $(if ($Endpoint) { [string]$Endpoint } else { [string]$Api.endpoint })
  $statusUrl = "$($endpointValue.TrimEnd('/'))/$([Uri]::EscapeDataString($taskId))"
  $headers = Get-AuthHeaders $Api
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
      $result = Invoke-RestMethod -Method Get -Uri $statusUrl -Headers $headers -TimeoutSec 60
    } catch {
      throw "查询生成任务失败：$($_.Exception.Message)"
    }
    $images = @(Get-ImagesFromPayload $result)
    if ($images.Count -gt 0) { return @($images) }
    if ($result.status -eq "failed") {
      $message = Get-PayloadMessage -Payload $result -Fallback "生成任务失败"
      throw $message
    }
  }
  throw "生成任务超时，请稍后在记录中查看或重试"
}

function Save-GeneratedImages($Images) {
  Ensure-Data
  $saved = @()
  $items = @(Get-ValueList $Images)
  for ($i = 0; $i -lt $items.Count; $i++) {
    $src = [string]$items[$i]
    $match = [regex]::Match($src, '^data:([^;,]+);base64,(.+)$')
    if (!$match.Success) {
      $saved += $src
      continue
    }
    $mime = $match.Groups[1].Value
    $ext = "png"
    if ($mime -match 'jpeg') { $ext = "jpg" }
    elseif ($mime -match 'webp') { $ext = "webp" }
    $fileName = "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$([Guid]::NewGuid())-$($i + 1).$ext"
    [IO.File]::WriteAllBytes((Join-Path $GeneratedDir $fileName), [Convert]::FromBase64String($match.Groups[2].Value))
    $saved += "/generated/$fileName"
  }
  return @($saved)
}

function Invoke-OpenAIResponsesImageTool($Api, [string]$Prompt, $Refs, [string]$Size, [string]$Quality) {
  $content = @([ordered]@{ type = "input_text"; text = $Prompt })
  foreach ($ref in @(Get-ValueList $Refs)) {
    $content += [ordered]@{ type = "input_image"; image_url = [string]$ref; detail = "auto" }
  }
  $ticketpro = Test-TicketproEndpoint $Api.endpoint
  if ($ticketpro) {
    $body = [ordered]@{
      model = $Api.model
      input = $(if ($content.Count -gt 1) { @([ordered]@{ role = "user"; content = @($content) }) } else { $Prompt })
      store = $true
    }
    if ($Size) { $body["size"] = $Size }
  } else {
    $tool = [ordered]@{ type = "image_generation" }
    if ($Size) { $tool["size"] = $Size }
    if ($Quality) { $tool["quality"] = $Quality }
    $body = [ordered]@{
      model = $Api.model
      input = @([ordered]@{ role = "user"; content = @($content) })
      tools = @($tool)
      tool_choice = [ordered]@{ type = "image_generation" }
      store = $false
    }
  }
  $json = ConvertTo-JsonText $body
  $utf8Body = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    $endpoint = Get-ResponsesEndpoint $Api.endpoint
    $result = Invoke-RestMethod -Method Post -Uri $endpoint -Headers (Get-AuthHeaders $Api) -ContentType "application/json; charset=utf-8" -Body $utf8Body -TimeoutSec 180
  } catch {
    $detail = $_.Exception.Message
    if ($_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        if ($text) { $detail = $text }
      } catch {}
    }
    throw $detail
  }
  $images = @(Get-ImagesFromPayload $result)
  if (!$images.Count) { throw "Responses image_generation 未返回可识别图片" }
  return @($images)
}

function Invoke-ImageApi($Api, [string]$Prompt, $Reference, [int]$Count, [string]$Quality, [string]$RequestSize = "1024x1024") {
  if ($Count -lt 1) { $Count = 1 }
  if ($Count -gt 9) { $Count = 9 }
  $images = @()
  $headers = Get-AuthHeaders $Api
  $refs = @(Get-ValueList $Reference)
  $provider = $(if ($Api.provider) { ([string]$Api.provider).ToLowerInvariant() } else { "auto" })
  $isGptImage = (Test-GptImageModel $Api.model) -or $provider -eq "openai"
  $useResponsesImageTool = $(if ($Api.PSObject.Properties["useResponsesImageTool"]) { [bool]$Api.useResponsesImageTool } else { $true })
  $requestSize = $(if ($RequestSize) { $RequestSize } else { Get-DefaultSize $Api })
  $qualityValue = $(if ($isGptImage) { $Quality } else { "" })

  for ($i = 1; $i -le $Count; $i++) {
    $promptToSend = $Prompt
    if ($Count -gt 1) {
      $promptToSend = "$Prompt`n生成第 $i 张图：保持同一主题和比例，构图、细节和镜头语言做自然变化。"
    }
    if ($isGptImage -and $useResponsesImageTool -and $qualityValue -in @("low", "medium")) {
      $images += @(Invoke-OpenAIResponsesImageTool -Api $Api -Prompt $promptToSend -Refs $refs -Size $requestSize -Quality $qualityValue)
      continue
    }
    $body = [ordered]@{
      model = $Api.model
      prompt = $promptToSend
      n = 1
      size = $requestSize
    }
    if ($isGptImage -and $qualityValue) {
      $body["quality"] = $qualityValue
    }
    if (!$isGptImage) {
      $body["response_format"] = "url"
      $body["stream"] = $false
      $body["watermark"] = $true
      $body["sequential_image_generation"] = "disabled"
    }
    if (!$isGptImage) {
      if ($refs.Count -eq 1) { $body["image"] = $refs[0] }
      elseif ($refs.Count -gt 1) { $body["image"] = @($refs) }
    }
    $json = ($body | ConvertTo-Json -Depth 20)
    $utf8Body = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    $endpoint = $(if ($isGptImage) { Get-ImageEndpoint -Endpoint $Api.endpoint -Action "generations" } else { $Api.endpoint })
    $result = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body $utf8Body -TimeoutSec 180
  } catch {
    $detail = $_.Exception.Message
    if ($_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        if ($text) { $detail = $text }
      } catch {}
    }
    throw $detail
  }
    $newImages = @(Get-ImagesFromPayload $result)
    if ($newImages.Count -eq 0) { $newImages = @(Wait-GenerationTask -Api $Api -Payload $result -Endpoint $endpoint) }
    $images += @($newImages)
  }

  if (!$images.Count) { throw "API 返回成功，但未找到图片 URL 或 base64 图片字段" }
  return $images
}

function Read-GenerationRecords {
  if (!(Test-Path $RecordFile)) { return @() }
  $lines = Get-Content -Path $RecordFile -Encoding UTF8 -Tail 100
  $records = @()
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line.Length -gt 200000) { continue }
    try {
      $record = ($line | ConvertFrom-Json)
      if ($record.referencePreviews) {
        foreach ($preview in @($record.referencePreviews)) {
          if ($preview.src -and ([string]$preview.src).Length -gt 200000) {
            $preview.src = ""
          }
        }
      }
      $records += $record
    } catch {}
  }
  return @($records | Select-Object -Last 100)
}

function Read-ClientRecords([string]$ClientId) {
  if (!$ClientId) { return @() }
  return @(Read-GenerationRecords | Where-Object { $_.clientId -and $_.clientId -eq $ClientId })
}

function Send-Static($Request, $Response) {
  $localPath = [Uri]::UnescapeDataString($Request.Url.AbsolutePath)
  if ($localPath -eq "/") { $localPath = "/index.html" }
  $target = [IO.Path]::GetFullPath((Join-Path $PublicDir $localPath.TrimStart("/")))
  $publicFull = [IO.Path]::GetFullPath($PublicDir)
  if (!$target.StartsWith($publicFull) -or !(Test-Path $target -PathType Leaf)) {
    $Response.StatusCode = 404
    $Response.OutputStream.Close()
    return
  }
  $types = @{ ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"; ".js" = "application/javascript; charset=utf-8" }
  $ext = [IO.Path]::GetExtension($target)
  $Response.ContentType = if ($types[$ext]) { $types[$ext] } else { "application/octet-stream" }
  $bytes = [IO.File]::ReadAllBytes($target)
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Send-Generated($Request, $Response) {
  Ensure-Data
  $fileName = [IO.Path]::GetFileName([Uri]::UnescapeDataString($Request.Url.AbsolutePath))
  $target = [IO.Path]::GetFullPath((Join-Path $GeneratedDir $fileName))
  $generatedFull = [IO.Path]::GetFullPath($GeneratedDir)
  if (!$target.StartsWith($generatedFull) -or !(Test-Path $target -PathType Leaf)) {
    $Response.StatusCode = 404
    $Response.OutputStream.Close()
    return
  }
  $types = @{ ".png" = "image/png"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg"; ".webp" = "image/webp" }
  $ext = [IO.Path]::GetExtension($target)
  $Response.ContentType = if ($types[$ext]) { $types[$ext] } else { "application/octet-stream" }
  $bytes = [IO.File]::ReadAllBytes($target)
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Send-Download($Request, $Response) {
  $url = Get-QueryParam -Request $Request -Name "url"
  $name = Get-QueryParam -Request $Request -Name "name"
  if ($url -and $url -match "^/generated/") {
    $fileName = [IO.Path]::GetFileName($url)
    $target = [IO.Path]::GetFullPath((Join-Path $GeneratedDir $fileName))
    $generatedFull = [IO.Path]::GetFullPath($GeneratedDir)
    if (!$target.StartsWith($generatedFull) -or !(Test-Path $target -PathType Leaf)) {
      Send-Json $Response 404 @{ error = "图片不存在" }
      return
    }
    if (!$name) { $name = $fileName }
    $safeName = ($name -replace '[\\/:*?"<>|]', "_")
    $encodedName = [Uri]::EscapeDataString($safeName)
    Send-Binary $Response 200 ([IO.File]::ReadAllBytes($target)) "application/octet-stream" @{
      "Content-Disposition" = "attachment; filename=`"$safeName`"; filename*=UTF-8''$encodedName"
      "Cache-Control" = "no-store"
    }
    return
  }
  if (!$url -or ($url -notmatch "^https?://")) {
    Send-Json $Response 400 @{ error = "下载地址无效" }
    return
  }
  if (!$name) { $name = "ai-image.png" }
  $safeName = ($name -replace '[\\/:*?"<>|]', "_")
  try {
    $client = New-Object Net.WebClient
    $bytes = $client.DownloadData($url)
    $contentType = $client.ResponseHeaders["Content-Type"]
    if (!$contentType) { $contentType = "application/octet-stream" }
    $encodedName = [Uri]::EscapeDataString($safeName)
    Send-Binary $Response 200 $bytes $contentType @{
      "Content-Disposition" = "attachment; filename=`"$safeName`"; filename*=UTF-8''$encodedName"
      "Cache-Control" = "no-store"
    }
  } catch {
    Send-Json $Response 502 @{ error = "图片下载失败：$($_.Exception.Message)" }
  } finally {
    if ($client) { $client.Dispose() }
  }
}

function Handle-Request($Context) {
  $req = $Context.Request
  $res = $Context.Response
  try {
    $path = $req.Url.AbsolutePath

    if ($req.HttpMethod -eq "GET" -and $path.StartsWith("/generated/")) {
      Send-Generated $req $res
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/models") {
      $config = Read-Config
      Send-Json $res 200 @{ models = @(Get-PublicApis $config) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/llm-models") {
      $config = Read-Config
      Ensure-LlmApisProperty $config
      Send-Json $res 200 @{ models = @(Get-PublicLlmApis $config) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/download") {
      Send-Download $req $res
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/records") {
      $clientId = Get-QueryParam -Request $req -Name "clientId"
      if (!$clientId) { Send-Json $res 400 @{ error = "缺少本机记录标识" }; return }
      Send-Json $res 200 @{ records = @(Read-ClientRecords -ClientId $clientId) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/prompt-records") {
      $clientId = Get-QueryParam -Request $req -Name "clientId"
      if (!$clientId) { Send-Json $res 400 @{ error = "缺少本机记录标识" }; return }
      Send-Json $res 200 @{ records = @(Read-ClientPromptRecords -ClientId $clientId) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/admin/config") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $config = Read-Config
      $apis = @()
      foreach ($api in @($config.apis)) {
        $copy = [ordered]@{}
        foreach ($prop in $api.PSObject.Properties) { $copy[$prop.Name] = $prop.Value }
        $copy.apiKey = if ($copy.apiKey) { "********" } else { "" }
        $apis += $copy
      }
      Send-Json $res 200 @{ username = $config.admin.username; apis = @($apis) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/admin/llm-config") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $config = Read-Config
      Ensure-LlmApisProperty $config
      $apis = @()
      foreach ($api in @($config.llmApis)) {
        $copy = [ordered]@{}
        foreach ($prop in $api.PSObject.Properties) { $copy[$prop.Name] = $prop.Value }
        $copy.apiKey = if ($copy.apiKey) { "********" } else { "" }
        $apis += $copy
      }
      Send-Json $res 200 @{ username = $config.admin.username; llmApis = @($apis) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/admin/records") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      Send-Json $res 200 @{ records = @(Read-GenerationRecords) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/admin/prompt-records") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      Send-Json $res 200 @{ records = @(Read-PromptRecords) }
      return
    }

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/admin/session") {
      $token = Get-CookieValue -Request $req -Name "admin_session"
      $valid = ($token -and $Sessions.ContainsKey($token) -and $Sessions[$token] -gt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
      if ($valid) {
        Send-Json $res 200 @{ authed = $true; authType = "legacy"; adminUser = $null }
      } else {
        Send-Json $res 200 @{ authed = $false }
      }
      return
    }

    if ($req.HttpMethod -eq "POST" -and $path -eq "/api/generate") {
      $body = Read-Body $req
      $visitor = ([string]$body.visitor).Trim()
      $clientId = ([string]$body.clientId).Trim()
      $prompt = ([string]$body.prompt).Trim()
      $originalPrompt = ([string]$body.originalPrompt).Trim()
      $aspect = ([string]$body.aspect).Trim()
      $requestedSize = ([string]$body.size).Trim()
      $modelId = ([string]$body.modelId).Trim()
      $reference = @()
      if ($body.reference -is [array]) {
        $reference = @(Get-ValueList $body.reference)
      } elseif ($body.reference) {
        $reference = @([string]$body.reference)
      }
      $referenceName = ([string]$body.referenceName).Trim()
      $referencePreviews = @(Get-ReferencePreviews -Names $referenceName -References $reference -IncomingPreviews $body.referencePreviews)
      $quality = Get-SanitizedQuality $body.quality
      $count = 1
      try { $count = [int]$body.count } catch { $count = 1 }
      if ($count -lt 1) { $count = 1 }
      if ($count -gt 9) { $count = 9 }
      if (!$visitor) { Send-Json $res 400 @{ error = "请先填写访问者身份" }; return }
      if (!$prompt) { Send-Json $res 400 @{ error = "Prompt 不能为空" }; return }
      $config = Read-Config
      $api = @($config.apis) | Where-Object { $_.id -eq $modelId -and $_.enabled -ne $false } | Select-Object -First 1
      if (!$api) { Send-Json $res 400 @{ error = "请选择可用的生图模型" }; return }
      try { $requestSize = Get-RequestSize -Api $api -RequestedSize $requestedSize } catch { Send-Json $res 400 @{ error = $_.Exception.Message }; return }
      $time = [DateTime]::UtcNow.ToString("o")
      try {
        $rawImages = @(Invoke-ImageApi -Api $api -Prompt $prompt -Reference $reference -Count $count -Quality $quality -RequestSize $requestSize)
        $images = @(Save-GeneratedImages $rawImages)
        Add-Log ([ordered]@{
          time = $time
          visitor = $visitor
          requestMode = Get-ApiRequestMode ([string]$api.endpoint)
          clientId = $clientId
          model = $api.name
          modelId = $api.id
          prompt = $(if ($originalPrompt) { $originalPrompt } else { $prompt })
          aspect = $aspect
          size = $requestSize
          quality = $quality
          referenceName = $(if ($referenceName) { $referenceName } else { "无" })
          referencePreviews = @($referencePreviews)
          count = $images.Count
          outputs = @($images)
          status = "success"
        })
        Send-Json $res 200 @{ images = @($images); image = $images[0] }
      } catch {
        Add-Log ([ordered]@{
          time = $time
          visitor = $visitor
          requestMode = Get-ApiRequestMode ([string]$api.endpoint)
          clientId = $clientId
          model = $api.name
          modelId = $api.id
          prompt = $(if ($originalPrompt) { $originalPrompt } else { $prompt })
          aspect = $aspect
          size = $requestSize
          quality = $quality
          referenceName = $(if ($referenceName) { $referenceName } else { "无" })
          referencePreviews = @($referencePreviews)
          count = $count
          outputs = @()
          status = "failed"
          error = $_.Exception.Message
        })
        Send-Json $res 502 @{ error = $_.Exception.Message }
      }
      return
    }

    if ($req.HttpMethod -eq "POST" -and $path -eq "/api/prompt-orchestrator/generate") {
      $body = Read-Body $req
      $visitor = ([string]$body.visitor).Trim()
      $clientId = ([string]$body.clientId).Trim()
      $mode = ([string]$body.mode).Trim()
      if (!$mode) { $mode = "text" }
      $modelId = ([string]$body.modelId).Trim()
      $description = ([string]$body.description).Trim()
      $styleTone = ([string]$body.styleTone).Trim()
      $aspectRatio = ([string]$body.aspectRatio).Trim()
      if (!$aspectRatio) { $aspectRatio = "16:9" }
      $preserve = @(Get-ValueList $body.preserve)
      $negative = @(Get-ValueList $body.negative)
      $imageDataUrls = @(Get-ValueList $body.imageDataUrls)
      if (!$imageDataUrls.Count -and $body.imageDataUrl) { $imageDataUrls = @(([string]$body.imageDataUrl).Trim()) }
      $imageDataUrl = $(if ($imageDataUrls.Count) { [string]$imageDataUrls[0] } else { "" })
      if (!$visitor) { Send-Json $res 400 @{ error = "请先填写访问者身份" }; return }
      if (!$description) { Send-Json $res 400 @{ error = "请先填写需求描述" }; return }
      if (!$modelId) { Send-Json $res 400 @{ error = "请选择一个可用的 LLM 模型" }; return }
      $config = Read-Config
      Ensure-LlmApisProperty $config
      $api = @($config.llmApis) | Where-Object { $_.id -eq $modelId -and $_.enabled -ne $false } | Select-Object -First 1
      if (!$api) { Send-Json $res 400 @{ error = "所选 LLM 模型不存在或已停用" }; return }
      $time = [DateTime]::UtcNow.ToString("o")
      try {
        $cards = @(Invoke-PromptOrchestratorLlm $api ([ordered]@{
          mode = $mode
          description = $description
          preserve = @($preserve)
          negative = @($negative)
          styleTone = $styleTone
          aspectRatio = $aspectRatio
          imageDataUrls = @($imageDataUrls)
          imageDataUrl = $imageDataUrl
        }))
        Add-PromptRecord ([ordered]@{
          time = $time
          visitor = $visitor
          clientId = $clientId
          mode = $mode
          model = $api.name
          modelId = $api.id
          description = $description
          styleTone = $styleTone
          aspectRatio = $aspectRatio
          preserve = @($preserve)
          negative = @($negative)
          inputImagePreview = $(if ($imageDataUrl.Length -le 200000) { $imageDataUrl } else { "" })
          inputImagePreviews = @($imageDataUrls | Where-Object { ([string]$_).Length -le 200000 })
          cards = @($cards)
          status = "success"
        })
        Send-Json $res 200 @{ cards = @($cards) }
      } catch {
        Add-PromptRecord ([ordered]@{
          time = $time
          visitor = $visitor
          clientId = $clientId
          mode = $mode
          model = $api.name
          modelId = $api.id
          description = $description
          styleTone = $styleTone
          aspectRatio = $aspectRatio
          preserve = @($preserve)
          negative = @($negative)
          inputImagePreview = $(if ($imageDataUrl.Length -le 200000) { $imageDataUrl } else { "" })
          inputImagePreviews = @($imageDataUrls | Where-Object { ([string]$_).Length -le 200000 })
          cards = @()
          status = "failed"
          error = $_.Exception.Message
        })
        Send-Json $res 502 @{ error = $_.Exception.Message }
      }
      return
    }

    if ($req.HttpMethod -eq "POST" -and $path -eq "/api/admin/apis/discover-sizes") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $body = Read-Body $req
      $config = Read-Config
      $current = @($config.apis) | Where-Object { $_.id -eq ([string]$body.id) } | Select-Object -First 1
      $apiKey = ([string]$body.apiKey).Trim()
      if ($apiKey -eq "********" -and $current) { $apiKey = $current.apiKey }
      $api = [pscustomobject]@{
        id = $(if ($body.id) { [string]$body.id } else { [guid]::NewGuid().ToString("N") })
        name = ([string]$body.name).Trim()
        model = ([string]$body.model).Trim()
        endpoint = ([string]$body.endpoint).Trim()
        apiKey = $apiKey
        size = $(if ($body.size) { ([string]$body.size).Trim() } else { "1024x1024" })
        supportedSizes = @(@($body.supportedSizes))
        provider = $(if ($body.provider) { [string]$body.provider } else { "auto" })
        editModel = $(if ($body.editModel) { ([string]$body.editModel).Trim() } else { "" })
      }
      if (!$api.model) { Send-Json $res 400 @{ error = "模型 ID 不能为空" }; return }
      if (!$api.endpoint) { Send-Json $res 400 @{ error = "API 地址不能为空" }; return }
      if (!$api.apiKey) { Send-Json $res 400 @{ error = "API Key 不能为空" }; return }
      Send-Json $res 200 (Discover-ImageSizes $api)
      return
    }

    if ($req.HttpMethod -eq "POST" -and $path -eq "/api/admin/apis") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $body = Read-Body $req
      $config = Read-Config
      $id = if ($body.id) { [string]$body.id } else { [guid]::NewGuid().ToString("N") }
      $incoming = [ordered]@{
        id = $id
        name = ([string]$body.name).Trim()
        model = ([string]$body.model).Trim()
        endpoint = ([string]$body.endpoint).Trim()
        apiKey = ([string]$body.apiKey).Trim()
        size = Get-NormalizedImageSize $(if ($body.size) { ([string]$body.size).Trim() } else { "1024x1024" })
        supportedSizes = @(Get-SupportedSizes $body)
        sizeSource = $(if ($body.sizeSource) { ([string]$body.sizeSource).Trim() } else { "manual" })
        sizeUpdatedAt = $(if ($body.sizeUpdatedAt) { ([string]$body.sizeUpdatedAt).Trim() } else { [DateTime]::UtcNow.ToString("o") })
        sizeDiscoveryNote = $(if ($body.sizeDiscoveryNote) { ([string]$body.sizeDiscoveryNote).Trim() } else { "手动配置支持尺寸" })
        requestModes = @(@($body.requestModes) | Where-Object { $_ -in @("generation", "edit") } | ForEach-Object { [string]$_ })
        provider = $(if ($body.provider) { [string]$body.provider } else { "auto" })
        useResponsesImageTool = [bool]$body.useResponsesImageTool
        editModel = $(if ($body.editModel) { ([string]$body.editModel).Trim() } else { "" })
        enabled = @(@($body.requestModes) | Where-Object { $_ -in @("generation", "edit") }).Count -gt 0
      }
      if (!$incoming.size -or $incoming.supportedSizes -notcontains $incoming.size) { $incoming.size = $incoming.supportedSizes[0] }
      $current = @($config.apis) | Where-Object { $_.id -eq $id } | Select-Object -First 1
      if ($incoming.apiKey -eq "********" -and $current) { $incoming.apiKey = $current.apiKey }
      if (!$incoming.name) { Send-Json $res 400 @{ error = "模型显示名称不能为空" }; return }
      if (!$incoming.model) { Send-Json $res 400 @{ error = "模型 ID 不能为空" }; return }
      if (!$incoming.endpoint) { Send-Json $res 400 @{ error = "API 地址不能为空" }; return }
      if (!$incoming.apiKey) { Send-Json $res 400 @{ error = "API Key 不能为空" }; return }
      $apis = @($config.apis) | Where-Object { $_.id -ne $id }
      $config.apis = @($apis + [pscustomobject]$incoming)
      Save-Config $config
      Send-Json $res 200 @{ ok = $true; api = $incoming }
      return
    }

    if ($req.HttpMethod -eq "POST" -and $path -eq "/api/admin/llm-apis") {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $body = Read-Body $req
      $config = Read-Config
      Ensure-LlmApisProperty $config
      $id = if ($body.id) { [string]$body.id } else { [guid]::NewGuid().ToString("N") }
      $incoming = [ordered]@{
        id = $id
        name = ([string]$body.name).Trim()
        model = ([string]$body.model).Trim()
        endpoint = ([string]$body.endpoint).Trim()
        apiKey = ([string]$body.apiKey).Trim()
        reasoningEffort = Normalize-ReasoningEffort $body.reasoningEffort
        enabled = ($body.enabled -ne $false)
      }
      $current = @($config.llmApis) | Where-Object { $_.id -eq $id } | Select-Object -First 1
      if ($incoming.apiKey -eq "********" -and $current) { $incoming.apiKey = $current.apiKey }
      if (!$incoming.name) { Send-Json $res 400 @{ error = "LLM 显示名称不能为空" }; return }
      if (!$incoming.model) { Send-Json $res 400 @{ error = "LLM 模型 ID 不能为空" }; return }
      if (!$incoming.endpoint) { Send-Json $res 400 @{ error = "LLM API 地址不能为空" }; return }
      if (!$incoming.apiKey) { Send-Json $res 400 @{ error = "LLM API Key 不能为空" }; return }
      $apis = @($config.llmApis) | Where-Object { $_.id -ne $id }
      $config.llmApis = @($apis + [pscustomobject]$incoming)
      Save-Config $config
      Send-Json $res 200 @{ ok = $true; api = $incoming }
      return
    }

    if ($req.HttpMethod -eq "DELETE" -and $path.StartsWith("/api/admin/apis/")) {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $id = [Uri]::UnescapeDataString($path.Substring("/api/admin/apis/".Length))
      $config = Read-Config
      $config.apis = @(@($config.apis) | Where-Object { $_.id -ne $id })
      Save-Config $config
      Send-Json $res 200 @{ ok = $true }
      return
    }

    if ($req.HttpMethod -eq "DELETE" -and $path.StartsWith("/api/admin/llm-apis/")) {
      if (!(Test-Admin $req)) { Send-Json $res 401 @{ error = "请先登录管理员账号" }; return }
      $id = [Uri]::UnescapeDataString($path.Substring("/api/admin/llm-apis/".Length))
      $config = Read-Config
      Ensure-LlmApisProperty $config
      $config.llmApis = @(@($config.llmApis) | Where-Object { $_.id -ne $id })
      Save-Config $config
      Send-Json $res 200 @{ ok = $true }
      return
    }

    if ($req.HttpMethod -eq "GET") { Send-Static $req $res; return }
    $res.StatusCode = 405
    $res.OutputStream.Close()
  } catch {
    try { Send-Json $res 500 @{ error = $_.Exception.Message } } catch {}
  }
}

Ensure-Data
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "AI image admin site running at http://127.0.0.1:$Port"
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    Handle-Request $context
  }
} finally {
  $listener.Stop()
}


















