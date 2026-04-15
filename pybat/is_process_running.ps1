param([string]$Keyword)
$processes = Get-CimInstance -ClassName Win32_Process -Filter "Name='pythonw.exe'"
$found = $processes | Where-Object { $_.CommandLine -like "*$Keyword*" }
if ($found) { exit 0 } else { exit 1 }
